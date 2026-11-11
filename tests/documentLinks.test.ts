import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type { PersistedDocumentState } from '../src/services/annotationPersistence.ts';
import type {
  SyncEntityRecord,
  SyncSnapshot,
  SyncTombstone,
} from '../src/sync/types.ts';
import type { DocumentLink } from '../src/types/documentLink.ts';
import type { GlossaryEntry } from '../src/types/glossary.ts';
import type { Note } from '../src/types/note.ts';
import type { PdfTextSelection } from '../src/types/textSelection.ts';

type PersistenceModule = typeof import('../src/services/annotationPersistence.ts');
type BackupModule = typeof import('../src/services/libraryBackup.ts');
type LocalAdapterModule = typeof import('../src/sync/localAdapter.ts');
type MergeModule = typeof import('../src/sync/merge.ts');
type HashModule = typeof import('../src/sync/hash.ts');
type LinksModule = typeof import('../src/utils/documentLinks.ts');
type LinkPresentationModule = typeof import('../src/utils/documentLinkPresentation.ts');
type NotesPanelSearchModule = typeof import('../src/utils/notesPanelSearch.ts');
type ReaderContextCandidatesModule =
  typeof import('../src/utils/readerContextCandidates.ts');

let server: ViteDevServer;
let persistence: PersistenceModule;
let backup: BackupModule;
let localAdapter: LocalAdapterModule;
let merge: MergeModule;
let hash: HashModule;
let documentLinks: LinksModule;
let linkPresentation: LinkPresentationModule;
let notesPanelSearch: NotesPanelSearchModule;
let readerContextCandidates: ReaderContextCandidatesModule;

before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  [
    persistence,
    backup,
    localAdapter,
    merge,
    hash,
    documentLinks,
    linkPresentation,
    notesPanelSearch,
    readerContextCandidates,
  ] = await Promise.all([
    server.ssrLoadModule(
      '/src/services/annotationPersistence.ts',
    ) as Promise<PersistenceModule>,
    server.ssrLoadModule('/src/services/libraryBackup.ts') as Promise<BackupModule>,
    server.ssrLoadModule('/src/sync/localAdapter.ts') as Promise<LocalAdapterModule>,
    server.ssrLoadModule('/src/sync/merge.ts') as Promise<MergeModule>,
    server.ssrLoadModule('/src/sync/hash.ts') as Promise<HashModule>,
    server.ssrLoadModule('/src/utils/documentLinks.ts') as Promise<LinksModule>,
    server.ssrLoadModule(
      '/src/utils/documentLinkPresentation.ts',
    ) as Promise<LinkPresentationModule>,
    server.ssrLoadModule(
      '/src/utils/notesPanelSearch.ts',
    ) as Promise<NotesPanelSearchModule>,
    server.ssrLoadModule(
      '/src/utils/readerContextCandidates.ts',
    ) as Promise<ReaderContextCandidatesModule>,
  ]);
});

after(async () => {
  await server.close();
});

const createUnpairedDocumentLink = (
  ...args: Parameters<LinksModule['createUnpairedDocumentLink']>
) => documentLinks.createUnpairedDocumentLink(...args);
const connectDocumentLink = (...args: Parameters<LinksModule['connectDocumentLink']>) =>
  documentLinks.connectDocumentLink(...args);
const connectableDocumentLinks = (
  ...args: Parameters<LinksModule['connectableDocumentLinks']>
) => documentLinks.connectableDocumentLinks(...args);
const deleteDocumentLink = (...args: Parameters<LinksModule['deleteDocumentLink']>) =>
  documentLinks.deleteDocumentLink(...args);
const otherDocumentLinkEndpoint = (
  ...args: Parameters<LinksModule['otherDocumentLinkEndpoint']>
) => documentLinks.otherDocumentLinkEndpoint(...args);
const repairDocumentLinkNumberCollisions = (
  ...args: Parameters<LinksModule['repairDocumentLinkNumberCollisions']>
) => documentLinks.repairDocumentLinkNumberCollisions(...args);
const sanitizeDocumentLink = (
  ...args: Parameters<LinksModule['sanitizeDocumentLink']>
) => documentLinks.sanitizeDocumentLink(...args);
const renameDocumentLink = (...args: Parameters<LinksModule['renameDocumentLink']>) =>
  documentLinks.renameDocumentLink(...args);

const DOCUMENT_ID = 'document-links-12345678';

test('Links preserve an opaque new-paper instance ID as their exact document scope', () => {
  const documentId =
    'pdfjs:synthetic-source-fingerprint:instance:11111111-1111-4111-8111-111111111111';
  const created = createUnpairedDocumentLink({
    documentId,
    selection: selection(1, 'instance source'),
    nextLinkNumber: 1,
    linkId: 'instance-link',
    endpointId: 'instance-endpoint-a',
    timestamp: 1,
  });
  assert.ok(created);
  assert.equal(created.link.documentId, documentId);
  assert.equal(sanitizeDocumentLink(created.link, documentId)?.documentId, documentId);
  assert.equal(
    sanitizeDocumentLink(created.link, 'pdfjs:synthetic-source-fingerprint'),
    null,
  );
});

test('Link allocation is document-scoped, monotonic, and does not reuse deletions', () => {
  let nextLinkNumber = 1;
  let links: DocumentLink[] = [];
  for (let index = 0; index < 3; index += 1) {
    const created = createUnpairedDocumentLink({
      documentId: DOCUMENT_ID,
      selection: selection(index + 1, `source ${index + 1}`),
      nextLinkNumber,
      linkId: `link-${index + 1}`,
      endpointId: `endpoint-${index + 1}-a`,
      timestamp: index + 1,
    });
    assert.ok(created);
    links = [...links, created.link];
    nextLinkNumber = created.nextLinkNumber;
  }
  assert.deepEqual(
    links.map(({ visibleNumber }) => visibleNumber),
    [1, 2, 3],
  );

  links = deleteDocumentLink(links, 'link-2');
  const fourth = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: selection(4, 'source 4'),
    nextLinkNumber,
    linkId: 'link-4',
    endpointId: 'endpoint-4-a',
    timestamp: 4,
  });
  assert.ok(fourth);
  assert.equal(fourth.link.visibleNumber, 4);
  assert.equal(fourth.nextLinkNumber, 5);
});

test('an unpaired Link accepts exactly one second endpoint and navigates both ways', () => {
  const created = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: selection(1, 'first'),
    nextLinkNumber: 2,
    linkId: 'link-pair',
    endpointId: 'endpoint-a',
    timestamp: 10,
  });
  assert.ok(created);
  assert.deepEqual(connectableDocumentLinks([created.link], DOCUMENT_ID), [
    created.link,
  ]);

  const paired = connectDocumentLink(created.link, {
    selection: selection(9, 'second'),
    endpointId: 'endpoint-b',
    timestamp: 11,
  });
  assert.ok(paired?.endpointB);
  assert.deepEqual(connectableDocumentLinks([paired], DOCUMENT_ID), []);
  assert.equal(
    connectDocumentLink(paired, { selection: selection(10, 'third') }),
    null,
  );
  assert.equal(otherDocumentLinkEndpoint(paired, 'endpoint-a')?.id, 'endpoint-b');
  assert.equal(otherDocumentLinkEndpoint(paired, 'endpoint-b')?.id, 'endpoint-a');
  assert.equal(otherDocumentLinkEndpoint(paired, 'not-an-endpoint'), null);
});

test('a clock-behind device can complete an existing Link without moving its clock backward', () => {
  const created = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: selection(1, 'first'),
    nextLinkNumber: 1,
    linkId: 'clock-skew-link',
    endpointId: 'clock-skew-a',
    timestamp: 1_000,
  });
  assert.ok(created);
  const completed = connectDocumentLink(created.link, {
    selection: selection(2, 'second'),
    endpointId: 'clock-skew-b',
    timestamp: 10,
  });
  assert.ok(completed?.endpointB);
  assert.equal(completed.updatedAt, 1_001);
  assert.equal(completed.endpointB.createdAt, 1_001);
  assert.equal(
    connectDocumentLink(
      { ...created.link, updatedAt: Number.MAX_SAFE_INTEGER },
      {
        selection: selection(3, 'exhausted target'),
        endpointId: 'clock-behind-exhausted',
        timestamp: 1,
      },
    ),
    null,
  );
});

test('Link names derive from identity and rename without changing the relationship', () => {
  const created = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: selection(1, 'named source'),
    nextLinkNumber: 5,
    linkId: 'named-link',
    endpointId: 'named-link-a',
    timestamp: 1_000,
  });
  assert.ok(created);
  assert.equal(linkPresentation.getDocumentLinkDisplayName(created.link), 'Link 5');
  assert.equal(Object.hasOwn(created.link, 'name'), false);
  assert.equal(
    renameDocumentLink(created.link, 'Link 5', { timestamp: 2_000 }),
    created.link,
    'saving the derived default must not freeze it as custom metadata',
  );

  const renamed = renameDocumentLink(created.link, '  Methods Jump  ', {
    timestamp: 10,
  });
  assert.ok(renamed);
  assert.equal(renamed.name, 'Methods Jump');
  assert.equal(renamed.id, created.link.id);
  assert.equal(renamed.visibleNumber, created.link.visibleNumber);
  assert.deepEqual(renamed.endpointA, created.link.endpointA);
  assert.equal(renamed.updatedAt, 1_001);
  assert.equal(linkPresentation.getDocumentLinkDisplayName(renamed), 'Methods Jump');
  assert.equal(
    renameDocumentLink(renamed, 'Methods Jump', { timestamp: 2_000 }),
    renamed,
    'a no-op rename must not manufacture a new update',
  );

  const paired = connectDocumentLink(renamed, {
    selection: selection(2, 'named destination'),
    endpointId: 'named-link-b',
    timestamp: 1_002,
  });
  assert.ok(paired?.endpointB);
  assert.equal(paired.name, 'Methods Jump');

  const reset = renameDocumentLink(paired, '   ', { timestamp: 1_003 });
  assert.ok(reset);
  assert.equal(Object.hasOwn(reset, 'name'), false);
  assert.equal(linkPresentation.getDocumentLinkDisplayName(reset), 'Link 5');
  assert.equal(reset.updatedAt, 1_003);

  const exhausted = { ...reset, updatedAt: Number.MAX_SAFE_INTEGER };
  assert.equal(
    renameDocumentLink(exhausted, 'Another name', { timestamp: 0 }),
    null,
    'a content-changing rename must fail closed when no newer safe version exists',
  );
  assert.equal(
    renameDocumentLink(exhausted, '', { timestamp: 0 }),
    exhausted,
    'a true no-op remains valid at the timestamp ceiling',
  );
});

test('Link creation rejects oversized IDs and raw selections with more than 64 rectangles', () => {
  const exactLimit = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: selection(1, 'bounded'),
    nextLinkNumber: 1,
    linkId: 'l'.repeat(256),
    endpointId: 'endpoint-bounded',
    timestamp: 1,
  });
  assert.ok(exactLimit);
  assert.equal(
    createUnpairedDocumentLink({
      documentId: DOCUMENT_ID,
      selection: selection(1, 'oversized'),
      nextLinkNumber: 1,
      linkId: 'l'.repeat(257),
      endpointId: 'endpoint-oversized',
      timestamp: 1,
    }),
    null,
  );

  const fragmented = selection(1, 'fragmented');
  fragmented.boundingRectangles = Array.from({ length: 65 }, (_, index) => ({
    left: 100 + index,
    top: 200,
    width: 1,
    height: 18,
  }));
  assert.equal(
    createUnpairedDocumentLink({
      documentId: DOCUMENT_ID,
      selection: fragmented,
      nextLinkNumber: 1,
      linkId: 'fragmented-link',
      endpointId: 'fragmented-endpoint',
      timestamp: 1,
    }),
    null,
  );
});

test('independent Links may share one range and deleting one removes only its pair', () => {
  const sharedSelection = selection(4, 'shared source');
  const first = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: sharedSelection,
    nextLinkNumber: 1,
    linkId: 'shared-link-1',
    endpointId: 'shared-link-1-a',
    timestamp: 20,
  });
  const second = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: sharedSelection,
    nextLinkNumber: 2,
    linkId: 'shared-link-2',
    endpointId: 'shared-link-2-a',
    timestamp: 20,
  });
  assert.ok(first && second);
  const pairedFirst = connectDocumentLink(first.link, {
    selection: selection(5, 'first destination'),
    endpointId: 'shared-link-1-b',
    timestamp: 21,
  });
  const pairedSecond = connectDocumentLink(second.link, {
    selection: selection(6, 'second destination'),
    endpointId: 'shared-link-2-b',
    timestamp: 21,
  });
  assert.ok(pairedFirst && pairedSecond);
  assert.deepEqual(
    pairedFirst.endpointA.anchor.rects,
    pairedSecond.endpointA.anchor.rects,
  );

  const remaining = deleteDocumentLink([pairedFirst, pairedSecond], pairedFirst.id);
  assert.deepEqual(remaining, [pairedSecond]);
  assert.equal(
    remaining.some(
      (link) =>
        link.endpointA.id === pairedFirst.endpointA.id ||
        link.endpointB?.id === pairedFirst.endpointB?.id,
    ),
    false,
  );
});

test('PDF.js reconstructed whitespace does not invalidate a Link endpoint', () => {
  const source = selection(3, 'two words');
  source.startOffset = 20;
  source.endOffset = 28; // DOM Range text omitted one reconstructed space.
  const created = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: source,
    nextLinkNumber: 1,
    linkId: 'link-whitespace',
    endpointId: 'endpoint-whitespace',
    timestamp: 12,
  });
  assert.ok(created);
  assert.equal(created.link.endpointA.anchor.startOffset, 20);
  assert.equal(created.link.endpointA.anchor.endOffset, 29);
  assert.equal(created.link.endpointA.anchor.quote, 'two words');
});

test('strict Link validation rejects cross-document, duplicate, and every third-endpoint encoding', () => {
  const link = completeLink('link-strict', 1);
  const legacyNameLessLink = sanitizeDocumentLink(link, DOCUMENT_ID);
  assert.ok(legacyNameLessLink);
  assert.equal(Object.hasOwn(legacyNameLessLink, 'name'), false);
  assert.equal(
    sanitizeDocumentLink({ ...link, name: '  Methods Jump  ' }, DOCUMENT_ID)?.name,
    'Methods Jump',
  );
  assert.equal(documentLinks.sanitizeDocumentLinkName('x'.repeat(80)), 'x'.repeat(80));
  for (const invalidName of ['', '   ', 'x'.repeat(81), 'Methods\nJump', null, 42]) {
    assert.equal(
      sanitizeDocumentLink({ ...link, name: invalidName }, DOCUMENT_ID),
      null,
      `invalid Link name ${JSON.stringify(invalidName)} must fail closed`,
    );
  }
  assert.equal(sanitizeDocumentLink(link, 'another-document-12345678'), null);
  assert.equal(
    sanitizeDocumentLink({ ...link, endpointB: { ...link.endpointA } }, DOCUMENT_ID),
    null,
  );
  assert.equal(
    sanitizeDocumentLink(
      { ...link, endpointC: { ...link.endpointA, id: 'endpoint-c' } },
      DOCUMENT_ID,
    ),
    null,
  );
  for (const unsupportedKey of ['endpoint3', 'endpoints', 'endpointExtra']) {
    assert.equal(
      sanitizeDocumentLink(
        { ...link, [unsupportedKey]: [{ ...link.endpointA, id: 'endpoint-extra' }] },
        DOCUMENT_ID,
      ),
      null,
      `${unsupportedKey} must fail closed instead of being discarded`,
    );
  }
});

test('number collision repair preserves IDs and is deterministic across input order', () => {
  const first = { ...completeLink('link-a', 2), name: 'First source' };
  const second = { ...completeLink('link-b', 2), name: 'Methods Jump' };
  const third = completeLink('link-c', 3);
  const forward = repairDocumentLinkNumberCollisions([second, third, first], 4);
  const reverse = repairDocumentLinkNumberCollisions([first, third, second], 4);
  const numbers = (links: readonly DocumentLink[]) =>
    Object.fromEntries(links.map((link) => [link.id, link.visibleNumber]));

  assert.deepEqual(numbers(forward.links), { 'link-b': 4, 'link-c': 3, 'link-a': 2 });
  assert.deepEqual(numbers(reverse.links), { 'link-a': 2, 'link-c': 3, 'link-b': 4 });
  assert.deepEqual(numbers(forward.links), numbers(reverse.links));
  assert.deepEqual(forward.renumberedLinkIds, ['link-b']);
  assert.equal(forward.nextLinkNumber, 5);
  assert.equal(new Set(forward.links.map(({ id }) => id)).size, 3);
  assert.equal(forward.links.find(({ id }) => id === 'link-b')?.name, 'Methods Jump');
  const unnamedRepair = repairDocumentLinkNumberCollisions(
    [first, { ...second, name: undefined }],
    3,
  );
  const repairedUnnamed = unnamedRepair.links.find(({ id }) => id === 'link-b');
  assert.ok(repairedUnnamed);
  assert.equal(linkPresentation.getDocumentLinkDisplayName(repairedUnnamed), 'Link 3');
});

test('number collision ownership uses locale-independent code-unit ID ordering', () => {
  const uppercase = completeLink('link-Z', 6);
  const lowercase = completeLink('link-a', 6);
  const repaired = repairDocumentLinkNumberCollisions([lowercase, uppercase], 7);
  assert.deepEqual(
    Object.fromEntries(repaired.links.map((link) => [link.id, link.visibleNumber])),
    { 'link-a': 7, 'link-Z': 6 },
  );
  assert.deepEqual(repaired.renumberedLinkIds, ['link-a']);
});

test('Link search syntax is case-insensitive and resolves paired and unpaired Links', () => {
  const paired = renameDocumentLink(
    completeLink('link-search-paired', 9),
    'Methods comparison',
    { timestamp: 120 },
  );
  assert.ok(paired);
  const unpaired = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: selection(7, 'waiting endpoint'),
    nextLinkNumber: 10,
    linkId: 'link-search-unpaired',
    endpointId: 'link-search-unpaired-a',
    timestamp: 110,
  });
  assert.ok(unpaired);
  const renamedSecond = renameDocumentLink(
    completeLink('link-search-renamed-second', 11),
    'Definition',
    { timestamp: 130 },
  );
  assert.ok(renamedSecond);
  const allLinks = [unpaired.link, renamedSecond, paired];
  const canonicalTextInCustomName = renameDocumentLink(
    completeLink('link-search-canonical-text', 12),
    'Methods link9 comparison',
    { timestamp: 140 },
  );
  const numericTextInCustomName = renameDocumentLink(
    completeLink('link-search-numeric-text', 13),
    'Chapter 9',
    { timestamp: 150 },
  );
  assert.ok(canonicalTextInCustomName);
  assert.ok(numericTextInCustomName);

  for (const query of ['link9', 'link 9', ' LINK   009 ', 'LiNk9']) {
    assert.equal(linkPresentation.parseDocumentLinkSearchQuery(query), 9);
    assert.equal(linkPresentation.isDocumentLinkSearchQuery(query), true);
  }
  for (const query of ['9', 'link', 'link 0', 'link -1', 'link 9 more']) {
    assert.equal(linkPresentation.parseDocumentLinkSearchQuery(query), null);
    assert.equal(linkPresentation.isDocumentLinkSearchQuery(query), false);
  }

  assert.equal(
    linkPresentation.findDocumentLinkByVisibleNumber([unpaired.link, paired], 9)?.id,
    paired.id,
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery([canonicalTextInCustomName, paired], 'link9')
      .map(({ id }) => id),
    [paired.id, canonicalTextInCustomName.id],
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery([unpaired.link, paired], 'link 9')
      .map(({ id }) => id),
    [paired.id],
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery(allLinks, 'link')
      .map(({ id }) => id),
    [paired.id, unpaired.link.id, renamedSecond.id],
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery(allLinks, ' METHODS   comparison ')
      .map(({ id }) => id),
    [paired.id],
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery(allLinks, 'Methods')
      .map(({ id }) => id),
    [paired.id],
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery([numericTextInCustomName, paired], '9')
      .map(({ id }) => id),
    [paired.id, numericTextInCustomName.id],
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery(allLinks, 'Definition')
      .map(({ id }) => id),
    [renamedSecond.id],
  );
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery([unpaired.link, paired], 'link 10')
      .map(({ id }) => id),
    [unpaired.link.id],
  );
  assert.equal(linkPresentation.matchesDocumentLinkName(paired, 'comparison'), true);
  assert.equal(linkPresentation.matchesDocumentLinkName(paired, 'results'), false);
  assert.deepEqual(
    linkPresentation
      .findDocumentLinksBySearchQuery(allLinks, '   ')
      .map(({ id }) => id),
    [paired.id, unpaired.link.id, renamedSecond.id],
  );
  assert.equal(linkPresentation.getDocumentLinkEndpointReferences([paired]).length, 2);
  assert.equal(
    linkPresentation.getDocumentLinkEndpointReferences([unpaired.link]).length,
    1,
  );
});

test('Link badge geometry preserves a painted gap on both sides and stays in page bounds', () => {
  const pageWidth = 600;
  const visualRadius = linkPresentation.DOCUMENT_LINK_BADGE_VISUAL_DIAMETER / 2;
  const hitTargetRadius = linkPresentation.DOCUMENT_LINK_BADGE_HIT_TARGET_DIAMETER / 2;
  const strokeRadius = linkPresentation.DOCUMENT_LINK_UNDERLINE_STROKE_WIDTH / 2;
  const assertClose = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 0.000_001, `${actual} != ${expected}`);
  const assertInPage = (
    geometry: ReturnType<LinkPresentationModule['getDocumentLinkBadgeGeometry']>,
  ) => {
    assert.ok(geometry.badgeVisualCenterX - visualRadius >= 0);
    assert.ok(geometry.badgeVisualCenterX + visualRadius <= pageWidth);
    assert.ok(geometry.badgeHitTargetCenterX - hitTargetRadius >= 0);
    assert.ok(geometry.badgeHitTargetCenterX + hitTargetRadius <= pageWidth);
    assert.ok(geometry.underlineStartX >= 0);
    assert.ok(geometry.underlineEndX <= pageWidth);
    assert.ok(geometry.underlineStartX <= geometry.underlineEndX);
  };

  const normal = linkPresentation.getDocumentLinkBadgeGeometry(
    { x: 0.2, width: 0.25 },
    pageWidth,
  );
  assert.equal(normal.isReversed, false);
  assertClose(
    normal.badgeVisualCenterX - visualRadius - (normal.underlineEndX + strokeRadius),
    linkPresentation.DOCUMENT_LINK_BADGE_VISIBLE_GAP,
  );
  assertInPage(normal);

  const reversed = linkPresentation.getDocumentLinkBadgeGeometry(
    { x: 0.72, width: 0.26 },
    pageWidth,
  );
  assert.equal(reversed.isReversed, true);
  assertClose(
    reversed.underlineStartX -
      strokeRadius -
      (reversed.badgeVisualCenterX + visualRadius),
    linkPresentation.DOCUMENT_LINK_BADGE_VISIBLE_GAP,
  );
  assertInPage(reversed);

  const clampedReversed = linkPresentation.getDocumentLinkBadgeGeometry(
    { x: 0.01, width: 0.98 },
    pageWidth,
    2,
  );
  assert.equal(clampedReversed.isReversed, true);
  assert.ok(clampedReversed.underlineStartX > pageWidth * 0.01);
  assertClose(
    clampedReversed.underlineStartX -
      strokeRadius -
      (clampedReversed.badgeVisualCenterX + visualRadius),
    linkPresentation.DOCUMENT_LINK_BADGE_VISIBLE_GAP,
  );
  assertInPage(clampedReversed);

  for (const underlineY of [visualRadius, 400, 800 - visualRadius]) {
    const vertical = linkPresentation.getDocumentLinkBadgeVerticalGeometry(
      underlineY,
      800,
    );
    assertClose(
      vertical.badgeHitTargetCenterY + vertical.badgeVisualOffsetY,
      underlineY,
    );
    assert.ok(vertical.badgeVisualCenterY - visualRadius >= 0);
    assert.ok(vertical.badgeVisualCenterY + visualRadius <= 800);
    assert.ok(vertical.badgeHitTargetCenterY - hitTargetRadius >= 0);
    assert.ok(vertical.badgeHitTargetCenterY + hitTargetRadius <= 800);
  }
});

test('coincident Link badges collapse to M with exact numbers and expand after deletion', () => {
  const source = selection(4, 'same source range');
  const first = pairedLinkFromSelections(
    'link-shared-a',
    2,
    source,
    selection(5, 'first target'),
  );
  const second = pairedLinkFromSelections(
    'link-shared-b',
    9,
    source,
    selection(6, 'second target'),
  );
  const endpointReferences = linkPresentation.getDocumentLinkEndpointsForPage(
    [second, first],
    4,
  );
  const groups = linkPresentation.getDocumentLinkBadgeGroups(endpointReferences);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'M');
  assert.deepEqual(groups[0].visibleNumbers, [2, 9]);
  assert.deepEqual(
    groups[0].targets.map(({ link }) => link.id),
    ['link-shared-a', 'link-shared-b'],
  );

  const remaining = deleteDocumentLink([first, second], first.id);
  const expanded = linkPresentation.getDocumentLinkBadgeGroups(
    linkPresentation.getDocumentLinkEndpointsForPage(remaining, 4),
  );
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].label, '9');
  assert.deepEqual(expanded[0].visibleNumbers, [9]);
});

test('wrapped Link endpoints place their badge at the final valid rectangle', () => {
  const link = completeLink('link-wrapped', 3);
  const firstRectangle = link.endpointA.anchor.rects[0];
  const finalRectangle = { x: 0.08, y: 0.31, width: 0.18, height: 0.02 };
  const anchor = {
    ...link.endpointA.anchor,
    rects: [
      firstRectangle,
      { x: 0.3, y: 0.27, width: 0, height: 0.02 },
      finalRectangle,
    ],
  };
  assert.deepEqual(
    linkPresentation.getDocumentLinkFinalRectangle(anchor),
    finalRectangle,
  );
  assert.equal(
    linkPresentation.getDocumentLinkFinalRectangle({ ...anchor, rects: [] }),
    null,
  );
});

test('Link endpoints participate in deterministic contextual candidate cycling', () => {
  const highNumber = completeLink('link-high', 11);
  const lowNumber = completeLink('link-low', 4);
  const endpoints = linkPresentation
    .getDocumentLinkEndpointsForPage([highNumber, lowNumber], 1)
    .reverse();
  const candidates = readerContextCandidates.createReaderContextCandidates(
    [],
    [],
    endpoints,
  );

  assert.deepEqual(candidates, [
    {
      kind: 'link',
      linkId: 'link-low',
      endpointId: 'link-low-endpoint-a',
    },
    {
      kind: 'link',
      linkId: 'link-high',
      endpointId: 'link-high-endpoint-a',
    },
  ]);
  const firstKey = readerContextCandidates.getReaderContextCandidateKey(candidates[0]);
  const secondKey = readerContextCandidates.getReaderContextCandidateKey(candidates[1]);
  assert.equal(
    readerContextCandidates.getAdjacentReaderContextCandidateKey(
      candidates,
      firstKey,
      1,
    ),
    secondKey,
  );
  assert.equal(
    readerContextCandidates.getAdjacentReaderContextCandidateKey(
      candidates,
      firstKey,
      -1,
    ),
    secondKey,
  );
});

test('Reader wiring exposes direct create, connect, and exact opposite-endpoint navigation', async () => {
  const [selectionActionSource, viewerSource, pageSource] = await Promise.all([
    readFile(
      new URL('../src/components/pdf/SelectionAction.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/components/Viewer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/pdf/PdfPage.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(selectionActionSource, />\s*Link\s*</u);
  assert.match(selectionActionSource, />\s*Create new Link\s*</u);
  assert.match(selectionActionSource, />\s*Connect to existing Link\s*</u);
  assert.match(viewerSource, /onCreateLink\(selection\)/u);
  assert.match(viewerSource, /onConnectLink\(linkId, selection\)/u);
  assert.match(
    viewerSource,
    /const otherEndpoint = otherDocumentLinkEndpoint\(link, endpointId\)[\s\S]*?navigateToLinkEndpoint\(link\.id, otherEndpoint\.id\)/u,
  );
  assert.match(pageSource, /const exactLinks = group\.visibleNumbers\.join\(', '\)/u);
  assert.match(pageSource, /const describedLinks = group\.targets/u);
  assert.match(pageSource, /`Multiple Links: \$\{describedLinks\}`/u);
  assert.match(pageSource, /getDocumentLinkDisplayName\(target\.link\)/u);
});

test('Link overlay keeps its lower fixed track, accessible badges, and presentation-only pulse', async () => {
  const [pageSource, viewerSource, contextSource, styleSource] = await Promise.all([
    readFile(new URL('../src/components/pdf/PdfPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Viewer.tsx', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/components/pdf/AnnotationTag.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/styles/index.css', import.meta.url), 'utf8'),
  ]);

  assert.ok(
    pageSource.indexOf('className="underline-rectangle"') <
      pageSource.indexOf('className="document-link-underline"'),
  );
  assert.match(
    pageSource,
    /const ordinaryUnderlineY = getUnderlineMetrics[\s\S]*?ordinaryUnderlineY \+ separateTrackOffset/u,
  );
  assert.match(styleSource, /\.document-link-underline\s*\{[^}]*stroke:\s*#581c87;/su);
  assert.match(
    styleSource,
    /\.document-link-badge-label\s*\{[^}]*width:\s*17px;[^}]*height:\s*17px;[^}]*background:\s*#7c3aed;/su,
  );
  assert.match(
    styleSource,
    /\.document-link-badge\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/su,
  );
  assert.match(
    styleSource,
    /\.document-link-badge-chooser button\s*\{[^}]*background:\s*#ede9fe;[^}]*color:\s*#4c1d95;/su,
  );
  assert.doesNotMatch(styleSource, /\.document-link-badge-cluster::before/u);
  assert.match(
    styleSource,
    /\.document-link-badge-chooser\s*\{[^}]*max-height:\s*min\(240px, 40vh\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/su,
  );
  assert.match(styleSource, /\.document-link-badge:focus-visible/u);
  assert.match(
    pageSource,
    /aria-label=\{[\s\S]*?`Multiple Links: \$\{describedLinks\}`/u,
  );
  assert.match(pageSource, /aria-describedby=\{isMultiple \? summaryId : undefined\}/u);
  assert.match(pageSource, /className="document-link-badge-summary"/u);
  assert.match(pageSource, /role="tooltip"/u);
  assert.match(pageSource, /role="group"/u);
  assert.doesNotMatch(pageSource, /role="menuitem"/u);
  assert.match(
    pageSource,
    /const anchorY = getLinkUnderlineY\(rectangle, dimensions\.height\)/u,
  );
  assert.match(
    pageSource,
    /const y = getLinkUnderlineY\(rectangle, dimensions\.height\)[\s\S]*?y1=\{y\}[\s\S]*?y2=\{y\}/u,
  );
  assert.match(
    pageSource,
    /top: `\$\{badgeVerticalGeometry\.badgeHitTargetCenterY\}px`[\s\S]*?transform: `translate\(\$\{badgeGeometry\.badgeVisualOffsetX\}px, \$\{badgeVerticalGeometry\.badgeVisualOffsetY\}px\)`/u,
  );
  assert.match(pageSource, /const isNearTop = anchorY < dimensions\.height \* 0\.16/u);
  assert.match(
    pageSource,
    /const isNearBottom = anchorY > dimensions\.height \* 0\.78/u,
  );
  assert.match(pageSource, /const isNearRight = badgeGeometry\.isReversed/u);
  assert.match(pageSource, /left: `\$\{badgeGeometry\.badgeHitTargetCenterX\}px`/u);
  assert.match(pageSource, /x1=\{[\s\S]*?badgeGeometry\?\.underlineStartX/u);
  assert.match(pageSource, /x2=\{[\s\S]*?badgeGeometry\?\.underlineEndX/u);
  assert.match(
    pageSource,
    /getDocumentLinkBadgeVerticalGeometry\([\s\S]*?anchorY,[\s\S]*?dimensions\.height/u,
  );
  assert.match(pageSource, /event\.key !== 'Escape'/u);

  const navigationStart = viewerSource.indexOf(
    'const applyDocumentLinkEndpointNavigation',
  );
  const navigationEnd = viewerSource.indexOf(
    'const navigateToLinkEndpoint',
    navigationStart,
  );
  const navigationSource = viewerSource.slice(navigationStart, navigationEnd);
  assert.match(navigationSource, /setActiveLinkEndpointId\(endpointId\)/u);
  assert.match(navigationSource, /setTimeout\(\(\) => \{/u);
  assert.match(
    navigationSource,
    /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/u,
  );
  assert.match(navigationSource, /behavior: 'smooth'/u);
  assert.match(navigationSource, /behavior: 'auto'/u);
  assert.match(navigationSource, /addEventListener\('scrollend'/u);
  assert.doesNotMatch(
    navigationSource,
    /updatedAt|onCreateLink|onConnectLink|onDeleteLink/u,
  );

  assert.match(contextSource, /'Paired' : 'Waiting for second endpoint'/u);
  assert.match(contextSource, />\s*Go to other endpoint\s*</u);
  assert.match(contextSource, />\s*Delete Link\s*</u);
});

test('Link naming, paired deletion confirmation, and drawer search stay connected to exact Link IDs', async () => {
  const [
    appSource,
    contextSource,
    notesSource,
    selectionSource,
    viewerSource,
    pdfSearchSource,
    pdfSearchHookSource,
  ] = await Promise.all([
    readFile(new URL('../src/components/AppLayout.tsx', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/components/pdf/AnnotationTag.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/components/NotesPanel.tsx', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/components/pdf/SelectionAction.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/components/Viewer.tsx', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/components/pdf/PdfSearchBar.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/hooks/usePdfSearch.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /const renameDocumentLinkName = useCallback/u);
  assert.match(appSource, /renameDocumentLink\(link, requestedName\)/u);
  assert.match(appSource, /if \(renamed === link\)/u);
  assert.match(appSource, /onRenameLink=\{renameDocumentLinkName\}/u);
  assert.match(contextSource, />\s*Rename Link\s*</u);
  assert.match(contextSource, /maxLength=\{MAX_DOCUMENT_LINK_NAME_LENGTH\}/u);
  assert.match(
    contextSource,
    /onRenameLink\(linkTarget\.link\.id, linkNameDraft\.trim\(\)\)/u,
  );
  assert.match(contextSource, /isConfirmingDeletion && linkTarget\.link\.endpointB/u);
  assert.match(contextSource, /Both endpoints will be deleted\./u);
  assert.match(
    contextSource,
    /isConfirmingDeletion && linkTarget\.link\.endpointB[\s\S]*?role="alert"[\s\S]*?<button\s+type="button"\s+autoFocus[\s\S]*?>[\s\S]*?Cancel/u,
  );
  assert.match(
    contextSource,
    /if \(linkTarget\.link\.endpointB\) \{[\s\S]*?setIsConfirmingDeletion\(true\)[\s\S]*?\} else \{[\s\S]*?onDeleteLink\(linkTarget\.link\.id, linkTarget\.endpoint\.id\)/u,
  );

  assert.match(notesSource, /Search Notes, Glossary, and Links/u);
  assert.match(notesSource, /aria-label="Notes, Glossary, and Links"/u);
  assert.match(
    notesSource,
    /findDocumentLinksBySearchQuery\(documentLinks, searchQuery\)/u,
  );
  assert.match(notesSource, /className="document-link-card"/u);
  assert.match(notesSource, /const identityLabel = `Link \$\{link\.visibleNumber\}`/u);
  assert.match(
    notesSource,
    /displayName !== identityLabel[\s\S]*?className="document-link-card-identity"[\s\S]*?\{identityLabel\}/u,
  );
  assert.match(notesSource, /Endpoint \{label\}/u);
  assert.match(notesSource, /onNavigate\?\.\(link\.id, endpoint\.id\)/u);
  assert.match(notesSource, /maxLength=\{MAX_DOCUMENT_LINK_NAME_LENGTH\}/u);
  assert.match(notesSource, /Delete both endpoints/u);
  assert.match(notesSource, /if \(link\.endpointB\) setIsConfirmingDeletion\(true\)/u);
  assert.equal((notesSource.match(/disabled=\{hasSearchQuery\}/gu) ?? []).length, 3);
  assert.match(appSource, /documentLinks=\{documentLinks\}/u);
  assert.match(appSource, /onRenameLink=\{renameDocumentLinkName\}/u);
  assert.match(appSource, /onDeleteLink=\{removeDocumentLink\}/u);
  assert.match(
    appSource,
    /viewerRef\.current\?\.navigateToLinkEndpoint\(linkId, endpointId\)/u,
  );
  assert.match(selectionSource, /selection-link-name/u);
  assert.doesNotMatch(viewerSource, /linkSearchSelection|isDocumentLinkSearchQuery/u);
  assert.doesNotMatch(
    pdfSearchSource,
    /PdfLinkSearchResultPresentation|linkQueryNumber|onNavigateLinkEndpoint/u,
  );
  assert.doesNotMatch(pdfSearchHookSource, /isSpecialQuery/u);
});

test('the shared drawer preserves the existing Notes and Glossary search behavior', () => {
  const note: Note = {
    id: 'note-search',
    annotationId: 'annotation-search',
    pageNumber: 3,
    displayNumber: 'N-14',
    selectedText: 'selected text',
    content: 'Independent note content',
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(notesPanelSearch.noteMatchesSearch(note, 'note content'), true);
  assert.equal(notesPanelSearch.noteMatchesSearch(note, 'n-14'), true);
  assert.equal(notesPanelSearch.noteMatchesSearch(note, 'selected text'), false);

  const glossaryEntry: GlossaryEntry = {
    glossaryEntryId: 'glossary-search',
    documentId: DOCUMENT_ID,
    displayedWord: 'Epistemology',
    normalizedLookupWord: 'epistemology',
    definition: 'The study of knowledge.',
    createdAt: 1,
    source: {
      dataset: 'Princeton WordNet',
      version: '3.1',
      license: 'Princeton WordNet License',
      sourceUrl: 'https://wordnet.princeton.edu/',
      partOfSpeech: 'noun',
    },
    pageNumber: 7,
    sourceRects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    startOffset: 1,
    endOffset: 12,
    markerAnnotationId: 'glossary-marker',
  };
  assert.equal(
    notesPanelSearch.glossaryEntryMatchesSearch(glossaryEntry, 'epistemology'),
    true,
  );
  assert.equal(
    notesPanelSearch.glossaryEntryMatchesSearch(glossaryEntry, 'knowledge'),
    true,
  );
  assert.equal(
    notesPanelSearch.glossaryEntryMatchesSearch(glossaryEntry, 'page 7'),
    true,
  );
  assert.equal(
    notesPanelSearch.glossaryEntryMatchesSearch(glossaryEntry, 'selected text'),
    false,
  );
});

test('Link choice controls stay keyboard-semantic and viewport-clamped', async () => {
  const [selectionSource] = await Promise.all([
    readFile(
      new URL('../src/components/pdf/SelectionAction.tsx', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(selectionSource, /<ul className="selection-link-chooser"/u);
  assert.match(selectionSource, /<li key=\{link\.id\}>[\s\S]*?<button/u);
  assert.doesNotMatch(selectionSource, /role="listitem"/u);
  assert.match(selectionSource, /new ResizeObserver\(placeInsideViewport\)/u);
  assert.match(selectionSource, /getVisualViewportBounds\(\)/u);
  assert.match(selectionSource, /clampFloatingSurfaceToViewport\(/u);
  assert.match(selectionSource, /visualViewport\?\.addEventListener\('resize'/u);
  assert.match(selectionSource, /visualViewport\?\.addEventListener\('scroll'/u);
  assert.match(selectionSource, /visualViewport\?\.removeEventListener\('resize'/u);
  assert.match(selectionSource, /visualViewport\?\.removeEventListener\('scroll'/u);
});

test('Link state is wired through reload, backup, global sync, and protocol-3 paper sync', async () => {
  const [
    appSource,
    persistenceSource,
    backupSource,
    syncSource,
    paperSource,
    typesSource,
  ] = await Promise.all([
    readFile(new URL('../src/components/AppLayout.tsx', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/services/annotationPersistence.ts', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/services/libraryBackup.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/sync/localAdapter.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/sync/paperLocalAdapter.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/sync/paperTypes.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /applyReaderEditableState\([\s\S]*?links: state\.links/u);
  assert.match(appSource, /captured\.documentLinks,\s*captured\.nextLinkNumber,/u);
  assert.match(persistenceSource, /ANNOTATION_DATABASE_VERSION = 5/u);
  assert.match(persistenceSource, /PERSISTENCE_SCHEMA_VERSION\s*=\s*9/u);
  assert.doesNotMatch(persistenceSource, /deleteObjectStore/u);
  assert.match(backupSource, /document\.state\.links\.length/u);
  assert.match(syncSource, /for \(const link of document\.links\)/u);
  assert.match(paperSource, /for \(const link of document\.state\.links\)/u);
  assert.match(typesSource, /PAPER_PACKAGE_LAYOUT_VERSION = 3/u);
  assert.match(typesSource, /PAPER_SYNC_PROTOCOL_VERSION = 3/u);
  assert.equal(backup.BACKUP_FORMAT_VERSION, 5);
});

test('schema 8 records migrate without Links and schema 9 backup records round-trip Links', () => {
  const legacy = {
    ...documentState([], 1),
    schemaVersion: persistence.FORMAT_GENERIC_PERSISTENCE_SCHEMA_VERSION,
  };
  Reflect.deleteProperty(legacy, 'links');
  Reflect.deleteProperty(legacy, 'nextLinkNumber');
  const migrated = persistence.validateBackupDocumentState(legacy);
  assert.ok(migrated);
  assert.equal(migrated.schemaVersion, persistence.PERSISTENCE_SCHEMA_VERSION);
  assert.deepEqual(migrated.links, []);
  assert.equal(migrated.nextLinkNumber, 1);

  const link = renameDocumentLink(completeLink('link-backup', 7), 'Methods Jump', {
    timestamp: 200,
  });
  assert.ok(link);
  const restored = persistence.validateBackupDocumentState(
    JSON.parse(JSON.stringify(documentState([link], 8))),
  );
  assert.ok(restored);
  assert.deepEqual(restored.links, [link]);
  assert.equal(restored.links[0].name, 'Methods Jump');
  assert.equal(restored.nextLinkNumber, 8);
  const nameLessLink = completeLink('link-backup-name-less', 8);
  const restoredNameLess = persistence.validateBackupDocumentState(
    JSON.parse(JSON.stringify(documentState([nameLessLink], 9))),
  );
  assert.ok(restoredNameLess);
  assert.equal(Object.hasOwn(restoredNameLess.links[0], 'name'), false);
  assert.equal(
    linkPresentation.getDocumentLinkDisplayName(restoredNameLess.links[0]),
    'Link 8',
  );
  assert.equal(
    persistence.validateBackupDocumentState({
      ...documentState([link], 7),
    }),
    null,
    'schema 9 must reject a high-water that does not exceed every live number',
  );
  const missingHighWater = { ...documentState([link], 8) } as Record<string, unknown>;
  Reflect.deleteProperty(missingHighWater, 'nextLinkNumber');
  assert.equal(persistence.validateBackupDocumentState(missingHighWater), null);
  const missingLinks = { ...documentState([], 1) } as Record<string, unknown>;
  Reflect.deleteProperty(missingLinks, 'links');
  assert.equal(persistence.validateBackupDocumentState(missingLinks), null);
  assert.equal(backup.BACKUP_FORMAT_VERSION, 5);
});

test('sync annotation entities round-trip Link identity and repair collisions', () => {
  const first = renameDocumentLink(completeLink('link-a', 1), 'First source', {
    timestamp: 200,
  });
  const second = renameDocumentLink(completeLink('link-b', 1), 'Methods Jump', {
    timestamp: 200,
  });
  assert.ok(first && second);
  const state = documentState([first, second], 2);
  const documentEntity = entity(
    'document',
    DOCUMENT_ID,
    localAdapter.documentValue(state),
  );
  const linkEntities = [
    entity('annotation', first.id, first, DOCUMENT_ID),
    entity('annotation', second.id, second, DOCUMENT_ID),
  ];
  const highWater = documentLinks.createDocumentLinkNumberHighWater(DOCUMENT_ID, 2);
  assert.ok(highWater);

  const restored = localAdapter.validatedDocumentState(DOCUMENT_ID, [
    documentEntity,
    entity(
      'link-number-high-water',
      documentLinks.DOCUMENT_LINK_HIGH_WATER_ENTITY_ID,
      highWater,
      DOCUMENT_ID,
    ),
    ...linkEntities,
  ]);
  assert.deepEqual(
    restored.links.map(({ id, visibleNumber, name }) => ({
      id,
      visibleNumber,
      name,
    })),
    [
      { id: 'link-a', visibleNumber: 1, name: 'First source' },
      { id: 'link-b', visibleNumber: 2, name: 'Methods Jump' },
    ],
  );
  assert.equal(restored.nextLinkNumber, 3);
  assert.deepEqual(restored.links[0].endpointA.anchor, first.endpointA.anchor);
});

test('Link allocation high-water merges by maximum independently of device clocks', () => {
  const local = currentSnapshot([], 2, 900, 'device-a');
  const remote = currentSnapshot([], 12, 10, 'device-b');
  const result = merge.mergeSyncSnapshots(local, remote, {}, 1_000).snapshot;
  const highWater = result.entities.find(
    (record) => record.kind === 'link-number-high-water',
  );
  assert.deepEqual(highWater?.value, {
    version: 1,
    type: 'link-number-high-water',
    documentId: DOCUMENT_ID,
    nextLinkNumber: 12,
  });
  assert.equal(highWater?.version.updatedAt, 10);
});

test('concurrent Link renames use the existing whole-entity version ordering', () => {
  const original = completeLink('link-rename-conflict', 1);
  const localLink = renameDocumentLink(original, 'Local name', { timestamp: 200 });
  const remoteLink = renameDocumentLink(original, 'Remote name', { timestamp: 300 });
  assert.ok(localLink && remoteLink);
  const local = currentSnapshot([localLink], 2, 200, 'device-a');
  const remote = currentSnapshot([remoteLink], 2, 300, 'device-b');
  const forward = merge.mergeSyncSnapshots(local, remote, {}, 400).snapshot;
  const reverse = merge.mergeSyncSnapshots(remote, local, {}, 400).snapshot;
  const selectedName = (snapshot: SyncSnapshot) =>
    (
      snapshot.entities.find(
        (record) => record.kind === 'annotation' && record.id === original.id,
      )?.value as DocumentLink | undefined
    )?.name;
  assert.equal(selectedName(forward), 'Remote name');
  assert.equal(selectedName(reverse), 'Remote name');
});

test('a clock-behind rename advances the same-device entity version', () => {
  const original = completeLink('link-rename-logical-tick', 1);
  const renamed = renameDocumentLink(original, 'Methods jump', { timestamp: 1 });
  assert.ok(renamed);
  assert.equal(renamed.updatedAt, original.updatedAt + 1);

  const before = currentSnapshot([original], 2, original.updatedAt, 'same-device');
  const afterRename = currentSnapshot([renamed], 2, renamed.updatedAt, 'same-device');
  const selectedName = (snapshot: SyncSnapshot) =>
    (
      snapshot.entities.find(
        (record) => record.kind === 'annotation' && record.id === original.id,
      )?.value as DocumentLink | undefined
    )?.name;

  assert.equal(
    selectedName(merge.mergeSyncSnapshots(before, afterRename, {}, 500).snapshot),
    'Methods jump',
  );
  assert.equal(
    selectedName(merge.mergeSyncSnapshots(afterRename, before, {}, 500).snapshot),
    'Methods jump',
  );
});

test('Link merge fails closed on malformed, regressed, missing, or duplicated high-water state', () => {
  const valid = currentSnapshot([], 2, 1, 'device-a');
  const malformed = currentSnapshot([], 3, 2, 'device-b');
  const malformedHighWater = malformed.entities.find(
    (record) => record.kind === 'link-number-high-water',
  );
  assert.ok(malformedHighWater);
  malformedHighWater.value = {
    ...malformedHighWater.value,
    documentId: 'different-document-12345678',
  };
  assert.throws(
    () => merge.mergeSyncSnapshots(valid, malformed, {}),
    /Link numbering metadata failed validation/u,
  );

  const link = completeLink('link-regressed', 3);
  const regressed = currentSnapshot([link], 3, 2, 'device-b');
  assert.throws(
    () => merge.mergeSyncSnapshots(valid, regressed, {}),
    /regressed Link numbering/u,
  );

  const missing = currentSnapshot([], 2, 2, 'device-b');
  missing.entities = missing.entities.filter(
    (record) => record.kind !== 'link-number-high-water',
  );
  assert.throws(
    () => merge.mergeSyncSnapshots(valid, missing, {}),
    /invalid Link numbering/u,
  );

  const duplicated = currentSnapshot([], 2, 2, 'device-b');
  const duplicate = duplicated.entities.find(
    (record) => record.kind === 'link-number-high-water',
  );
  assert.ok(duplicate);
  duplicated.entities.push(structuredClone(duplicate));
  assert.throws(
    () => merge.mergeSyncSnapshots(valid, duplicated, {}),
    /invalid Link numbering/u,
  );
});

test('concurrent Link-number collisions converge with coherent deterministic versions', () => {
  const localLink = renameDocumentLink(completeLink('link-a', 1), 'Local jump', {
    timestamp: 100,
  });
  const remoteLink = renameDocumentLink(completeLink('link-b', 1), 'Remote jump', {
    timestamp: 200,
  });
  assert.ok(localLink && remoteLink);
  const local = currentSnapshot([localLink], 2, 100, 'device-a');
  const remote = currentSnapshot([remoteLink], 2, 200, 'device-b');
  const forward = merge.mergeSyncSnapshots(local, remote, {}, 300).snapshot;
  const reverse = merge.mergeSyncSnapshots(remote, local, {}, 300).snapshot;
  const relevant = (snapshot: SyncSnapshot) =>
    snapshot.entities
      .filter(
        (record) =>
          record.kind === 'link-number-high-water' ||
          (record.kind === 'annotation' &&
            typeof record.value === 'object' &&
            record.value !== null &&
            (record.value as { type?: unknown }).type === 'link'),
      )
      .map((record) => ({
        key: record.key,
        value: record.value,
        version: record.version,
      }));
  assert.deepEqual(relevant(forward), relevant(reverse));

  const links = forward.entities
    .filter((record) => record.kind === 'annotation')
    .map((record) => record.value as DocumentLink)
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    links.map(({ id, visibleNumber, name }) => ({ id, visibleNumber, name })),
    [
      { id: 'link-a', visibleNumber: 1, name: 'Local jump' },
      { id: 'link-b', visibleNumber: 2, name: 'Remote jump' },
    ],
  );
  const repaired = forward.entities.filter(
    (record) => record.kind === 'link-number-high-water' || record.id === 'link-b',
  );
  assert.equal(repaired.length, 2);
  for (const record of repaired) {
    assert.equal(record.version.updatedAt, 201);
    assert.equal(record.version.deviceId, '39note-link-number-repair');
    assert.equal(
      record.version.hash,
      hash.sha256HexSync(hash.stableStringify(record.value)),
    );
  }
});

test('Keep local retains the verified remote maximum high-water without remote Link bodies', () => {
  const localLink = completeLink('link-local', 1);
  const remoteLink = completeLink('link-remote', 8);
  const local = currentSnapshot([localLink], 2, 900, 'device-local');
  const remote = currentSnapshot([remoteLink], 9, 10, 'device-remote');
  const kept = merge.preserveLinkNumberHighWaterForKeepLocal(local, remote);
  const linkIds = kept.entities
    .filter((record) => record.kind === 'annotation')
    .map((record) => record.id);
  assert.deepEqual(linkIds, ['link-local']);
  assert.equal(
    (
      kept.entities.find((record) => record.kind === 'link-number-high-water')
        ?.value as { nextLinkNumber: number }
    ).nextLinkNumber,
    9,
  );
});

test('released schema-8 sync snapshots remain valid without Link high-water metadata', () => {
  const state = documentState([], 1);
  const legacyDocumentValue = {
    ...localAdapter.documentValue(state),
    schemaVersion: persistence.FORMAT_GENERIC_PERSISTENCE_SCHEMA_VERSION,
  };
  const legacy = snapshot([entity('document', DOCUMENT_ID, legacyDocumentValue)]);
  const merged = merge.mergeSyncSnapshots(legacy, structuredClone(legacy), {}).snapshot;
  const restored = localAdapter.validatedDocumentState(DOCUMENT_ID, merged.entities);
  assert.deepEqual(restored.links, []);
  assert.equal(restored.nextLinkNumber, 1);
});

test('released schema-8 compatibility guard fails closed on schema-9 Link metadata', () => {
  assert.equal(persistence.PERSISTENCE_SCHEMA_VERSION, 9);
  assert.equal(
    localAdapter.cloudDocumentType(
      { schemaVersion: persistence.PERSISTENCE_SCHEMA_VERSION, documentType: 'pdf' },
      persistence.FORMAT_GENERIC_PERSISTENCE_SCHEMA_VERSION,
    ),
    null,
  );
  assert.equal(
    localAdapter.cloudDocumentType(
      {
        schemaVersion: persistence.FORMAT_GENERIC_PERSISTENCE_SCHEMA_VERSION,
        documentType: 'pdf',
      },
      persistence.FORMAT_GENERIC_PERSISTENCE_SCHEMA_VERSION,
    ),
    'pdf',
  );
});

function selection(pageNumber: number, text: string): PdfTextSelection {
  return {
    text,
    pageNumber,
    pageWidth: 1_000,
    pageHeight: 1_400,
    boundingRectangles: [{ left: 100, top: 200, width: 120, height: 18 }],
    startOffset: 0,
    endOffset: text.length,
  };
}

function completeLink(id: string, visibleNumber: number): DocumentLink {
  return pairedLinkFromSelections(
    id,
    visibleNumber,
    selection(1, `${id} first`),
    selection(2, `${id} second`),
  );
}

function pairedLinkFromSelections(
  id: string,
  visibleNumber: number,
  source: PdfTextSelection,
  target: PdfTextSelection,
): DocumentLink {
  const first = createUnpairedDocumentLink({
    documentId: DOCUMENT_ID,
    selection: source,
    nextLinkNumber: visibleNumber,
    linkId: id,
    endpointId: `${id}-endpoint-a`,
    timestamp: 100,
  });
  assert.ok(first);
  const paired = connectDocumentLink(first.link, {
    selection: target,
    endpointId: `${id}-endpoint-b`,
    timestamp: 101,
  });
  assert.ok(paired);
  return paired;
}

function documentState(
  links: DocumentLink[],
  nextLinkNumber: number,
): PersistedDocumentState {
  return {
    schemaVersion: persistence.PERSISTENCE_SCHEMA_VERSION,
    documentType: 'pdf',
    documentId: DOCUMENT_ID,
    documentName: 'links.pdf',
    originalFileName: 'links.pdf',
    displayTitle: 'Links',
    annotations: [],
    links,
    officeAnnotations: [],
    noteAnchors: [],
    notes: [],
    glossaryEntries: [],
    nextNoteNumber: 1,
    nextLinkNumber,
    updatedAt: 101,
    collectionIds: [],
    isPinned: false,
  };
}

function entity(
  kind: SyncEntityRecord['kind'],
  id: string,
  value: unknown,
  documentId?: string,
): SyncEntityRecord {
  return {
    key: `${kind}:${documentId ?? ''}:${id}`,
    kind,
    id,
    ...(documentId ? { documentId } : {}),
    value,
    version: { updatedAt: 101, deviceId: 'device-a', hash: 'fixture-hash' },
  };
}

function currentSnapshot(
  links: DocumentLink[],
  nextLinkNumber: number,
  updatedAt: number,
  deviceId: string,
): SyncSnapshot {
  const state = documentState(links, nextLinkNumber);
  const highWater = documentLinks.createDocumentLinkNumberHighWater(
    DOCUMENT_ID,
    nextLinkNumber,
  );
  assert.ok(highWater);
  const records = [
    entity('document', DOCUMENT_ID, localAdapter.documentValue(state)),
    entity(
      'link-number-high-water',
      documentLinks.DOCUMENT_LINK_HIGH_WATER_ENTITY_ID,
      highWater,
      DOCUMENT_ID,
    ),
    ...links.map((link) => entity('annotation', link.id, link, DOCUMENT_ID)),
  ].map((record) => ({
    ...record,
    version: {
      updatedAt,
      deviceId,
      hash: hash.sha256HexSync(hash.stableStringify(record.value)),
    },
  }));
  return snapshot(records);
}

function snapshot(
  entities: SyncEntityRecord[],
  tombstones: SyncTombstone[] = [],
): SyncSnapshot {
  return {
    app: '39Note',
    syncSchemaVersion: 1,
    generatedAt: 1,
    generatedBy: 'fixture',
    entities,
    tombstones,
    pdfs: [],
  };
}
