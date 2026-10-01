import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import {
  createImageDominantPptxFixture,
  createSimpleDocxFixture,
  createSimplePptxFixture,
  passiveSvgImage,
  tinyJpegImage,
} from './fixtures/ooxmlFixtures.ts';
import { Ream } from 'reamkit';

type EngineModule = typeof import('../src/conversion/office/engine.ts');
type ServiceModule = typeof import('../src/conversion/office/service.ts');
type ProtocolModule = typeof import('../src/conversion/office/protocol.ts');
type OfficeTypesModule = typeof import('../src/conversion/office/types.ts');
type ValidationModule = typeof import('../src/conversion/office/validation.ts');
type PptxSanitizerModule = typeof import('../src/conversion/office/pptxSanitizer.ts');
type OoxmlPackageModule = typeof import('../src/documents/ooxml/package.ts');
type CoordinatorModule = typeof import('../src/sync/paperCoordinator.ts');
type SourceValidationModule =
  typeof import('../src/services/documentSourceValidation.ts');

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

let server: ViteDevServer;
let engine: EngineModule;
let service: ServiceModule;
let protocol: ProtocolModule;
let officeTypes: OfficeTypesModule;
let validation: ValidationModule;
let pptxSanitizer: PptxSanitizerModule;
let ooxmlPackage: OoxmlPackageModule;
let coordinator: CoordinatorModule;
let sourceValidation: SourceValidationModule;
let fonts: Parameters<EngineModule['convertOfficeBytesToPdf']>[0]['fonts'];
let cjkFont: Uint8Array;

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
    engine,
    service,
    protocol,
    officeTypes,
    validation,
    pptxSanitizer,
    ooxmlPackage,
    coordinator,
    sourceValidation,
  ] = await Promise.all([
    server.ssrLoadModule('/src/conversion/office/engine.ts') as Promise<EngineModule>,
    server.ssrLoadModule('/src/conversion/office/service.ts') as Promise<ServiceModule>,
    server.ssrLoadModule(
      '/src/conversion/office/protocol.ts',
    ) as Promise<ProtocolModule>,
    server.ssrLoadModule(
      '/src/conversion/office/types.ts',
    ) as Promise<OfficeTypesModule>,
    server.ssrLoadModule(
      '/src/conversion/office/validation.ts',
    ) as Promise<ValidationModule>,
    server.ssrLoadModule(
      '/src/conversion/office/pptxSanitizer.ts',
    ) as Promise<PptxSanitizerModule>,
    server.ssrLoadModule(
      '/src/documents/ooxml/package.ts',
    ) as Promise<OoxmlPackageModule>,
    server.ssrLoadModule('/src/sync/paperCoordinator.ts') as Promise<CoordinatorModule>,
    server.ssrLoadModule(
      '/src/services/documentSourceValidation.ts',
    ) as Promise<SourceValidationModule>,
  ]);
  fonts = {
    regular: fontBytes(
      '../node_modules/@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf',
    ),
    bold: fontBytes(
      '../node_modules/@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf',
    ),
    italic: fontBytes(
      '../node_modules/@expo-google-fonts/arimo/400Regular_Italic/Arimo_400Regular_Italic.ttf',
    ),
    boldItalic: fontBytes(
      '../node_modules/@expo-google-fonts/arimo/700Bold_Italic/Arimo_700Bold_Italic.ttf',
    ),
  };
  cjkFont = fontBytes(
    '../node_modules/@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf',
  );
});

after(async () => server.close());

test('DOCX converts locally to valid PDF bytes with selectable text', async () => {
  const result = await engine.convertOfficeBytesToPdf({
    bytes: await createSimpleDocxFixture({ includeExternalHyperlink: true }),
    expectedType: 'docx',
    fonts,
  });

  assert.equal(result.sourceType, 'docx');
  assert.equal(
    new TextDecoder().decode(new Uint8Array(result.pdfBytes).subarray(0, 5)),
    '%PDF-',
  );
  assert.ok(result.sourceTextCharacters > 0);
  assert.ok(result.pdfTextCharacters > 0);
  await assertPdfJsReadable(result.pdfBytes, /Research heading/u);

  const convertedFile = validation.createConvertedPdfFile(
    'Essay.docx',
    result.pdfBytes,
  );
  assert.equal(convertedFile.name, 'Essay.pdf');
  assert.equal(convertedFile.type, 'application/pdf');
  const stored = await sourceValidation.createStoredDocumentSource(
    'converted-docx-paper',
    convertedFile,
    'pdf',
  );
  assert.equal(stored?.documentType, 'pdf');
  assert.equal(stored?.mimeType, 'application/pdf');
  assert.equal(stored?.fileName, 'Essay.pdf');
});

test('PPTX converts locally to valid PDF bytes with selectable slide text', async () => {
  const result = await engine.convertOfficeBytesToPdf({
    bytes: await createSimplePptxFixture(),
    expectedType: 'pptx',
    fonts,
  });

  assert.equal(result.sourceType, 'pptx');
  assert.equal(
    new TextDecoder().decode(new Uint8Array(result.pdfBytes).subarray(0, 5)),
    '%PDF-',
  );
  assert.ok(result.sourceTextCharacters > 0);
  assert.ok(result.pdfTextCharacters > 0);
  assert.equal(result.pageCount, 2);
  await assertPdfJsReadable(result.pdfBytes, /Slide 1 searchable text/u);
});

test('relationship-bound passive SVG is classified and omitted with explicit fidelity feedback', async () => {
  const svgBytes = passiveSvgImage({
    rootAttributes:
      'xmlns:xlink="http://www.w3.org/1999/xlink" contentScriptType="text/ecmascript"',
  });
  const sourceBytes = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: svgBytes,
    imageContentType: 'image/svg+xml',
    imageExtension: 'svg',
    useSvgBlip: true,
  });
  const pkg = await ooxmlPackage.OoxmlPackage.open(sourceBytes, 'pptx');
  const relationship = (await pkg.getRelationships('ppt/slides/slide1.xml')).get(
    'rImage',
  );
  assert.deepEqual(relationship, {
    id: 'rImage',
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    mode: 'internal',
    targetPart: 'ppt/media/image1.svg',
  });
  assert.deepEqual(await pkg.validateImagePart('ppt/media/image1.svg'), {
    path: 'ppt/media/image1.svg',
    byteSize: svgBytes.byteLength,
    declaredMimeType: 'image/svg+xml',
    mimeType: 'image/svg+xml',
    disposition: 'safe-unsupported',
    format: 'SVG',
    metadataNormalized: false,
  });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('Unexpected network access');
  }) as typeof fetch;
  try {
    const result = await engine.convertOfficeBytesToPdf({
      bytes: sourceBytes,
      expectedType: 'pptx',
      fonts,
    });
    assert.equal(result.pageCount, 1);
    assert.equal(result.losses.unsupportedImagesOmitted, 1);
    assert.match(await extractPdfText(result.pdfBytes), /Slide 1 searchable text/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.match(
    source('../src/components/OfficePdfConverterDialog.tsx'),
    /Converted with.*unsupported.*images?.*omitted/u,
  );
});

test('relationship-bound JPEG bytes declared as PNG normalize by signature without network access', async () => {
  const jpegBytes = tinyJpegImage();
  const sourceBytes = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: jpegBytes,
    imageContentType: 'image/png',
    imageExtension: 'png',
    slideTexts: ['真实演绎论证 searchable text'],
  });
  const pkg = await ooxmlPackage.OoxmlPackage.open(sourceBytes, 'pptx');
  const relationship = (await pkg.getRelationships('ppt/slides/slide1.xml')).get(
    'rImage',
  );
  assert.deepEqual(relationship, {
    id: 'rImage',
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    mode: 'internal',
    targetPart: 'ppt/media/image1.png',
  });
  await assert.rejects(
    pkg.validateImagePart('ppt/media/image1.png'),
    /does not match its declared media type/iu,
  );
  assert.deepEqual(
    await pkg.validateImagePart('ppt/media/image1.png', {
      officeImageRelationship: true,
    }),
    {
      path: 'ppt/media/image1.png',
      byteSize: jpegBytes.byteLength,
      declaredMimeType: 'image/png',
      mimeType: 'image/jpeg',
      disposition: 'supported',
      format: 'JPEG',
      metadataNormalized: true,
    },
  );
  const resource = pkg.createImageResource('ppt/media/image1.png', {
    officeImageRelationship: true,
  });
  assert.deepEqual(await resource.load(), jpegBytes);
  assert.equal(resource.mimeType, 'image/jpeg');

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('Unexpected external media fetch');
  }) as typeof fetch;
  try {
    const result = await engine.convertOfficeBytesToPdf({
      bytes: sourceBytes,
      expectedType: 'pptx',
      fonts,
      loadCjkFont: async () => cjkFont,
    });
    assert.equal(result.pageCount, 1);
    assert.equal(result.losses.metadataNormalizedImages, 1);
    assert.equal(result.losses.unsupportedImagesOmitted, 0);
    assert.match(await extractPdfText(result.pdfBytes), /演绎论证/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.match(
    source('../src/components/OfficePdfConverterDialog.tsx'),
    /inconsistent metadata.*safely normalized/u,
  );
});

test('image metadata normalization stays closed without exact safe relationship semantics', async () => {
  const jpegBytes = tinyJpegImage();
  const unsafeRelationship = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: jpegBytes,
    imageContentType: 'image/png',
    imageExtension: 'png',
    imageRelationshipType: 'https://example.test/relationships/image',
  });
  await assert.rejects(
    engine.convertOfficeBytesToPdf({
      bytes: unsafeRelationship,
      expectedType: 'pptx',
      fonts,
    }),
    /does not match its declared media type/iu,
  );

  const unsafeExtension = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: jpegBytes,
    imageContentType: 'image/png',
    imageExtension: 'bin',
  });
  await assert.rejects(
    engine.convertOfficeBytesToPdf({
      bytes: unsafeExtension,
      expectedType: 'pptx',
      fonts,
    }),
    /does not match its declared media type/iu,
  );

  const unknownSignature = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9]),
    imageContentType: 'image/png',
    imageExtension: 'png',
  });
  await assert.rejects(
    engine.convertOfficeBytesToPdf({
      bytes: unknownSignature,
      expectedType: 'pptx',
      fonts,
    }),
    /does not match its declared media type/iu,
  );
});

test('SVG MIME/signature mismatches and active SVG content remain fail-closed', async () => {
  const extensionMismatch = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: passiveSvgImage(),
    imageContentType: 'image/svg+xml',
    imageExtension: 'png',
    useSvgBlip: true,
  });
  await assert.rejects(
    () =>
      engine.convertOfficeBytesToPdf({
        bytes: extensionMismatch,
        expectedType: 'pptx',
        fonts,
      }),
    /does not match its declared file extension/iu,
  );

  const mismatched = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    imageContentType: 'image/svg+xml',
    imageExtension: 'svg',
    useSvgBlip: true,
  });
  await assert.rejects(
    () =>
      engine.convertOfficeBytesToPdf({
        bytes: mismatched,
        expectedType: 'pptx',
        fonts,
      }),
    /SVG image is malformed|declared media type/iu,
  );

  const active = await createSimplePptxFixture({
    slideCount: 1,
    imageBytes: passiveSvgImage({
      activeMarkup: '<script>globalThis.compromised = true</script>',
    }),
    imageContentType: 'image/svg+xml',
    imageExtension: 'svg',
    useSvgBlip: true,
  });
  await assert.rejects(
    () =>
      engine.convertOfficeBytesToPdf({
        bytes: active,
        expectedType: 'pptx',
        fonts,
      }),
    /active or externally referenced SVG image/iu,
  );
});

test('externally referenced images fail closed without a network request', async () => {
  const sourceBytes = await createSimplePptxFixture({
    slideCount: 1,
    imageContentType: 'image/svg+xml',
    imageExtension: 'svg',
    imageRelationshipTargetMode: 'External',
    maliciousRelationshipTarget: 'https://example.test/icon.svg',
    useSvgBlip: true,
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('Unexpected network access');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        engine.convertOfficeBytesToPdf({
          bytes: sourceBytes,
          expectedType: 'pptx',
          fonts,
        }),
      /externally referenced image/iu,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test('Chinese DOCX uses the lazy local CJK face and preserves searchable Unicode', async () => {
  const fixtureText = '简体中文與繁體中文 cognitive neuroscience 2026，測試。';
  let cjkLoads = 0;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error('External font fetch is prohibited.');
  }) as typeof fetch;
  try {
    const result = await engine.convertOfficeBytesToPdf({
      bytes: await createSimpleDocxFixture({
        documentXml: `<?xml version="1.0" encoding="UTF-8"?>
          <w:document xmlns:w="w"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei"/></w:rPr><w:t>${fixtureText}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
      }),
      expectedType: 'docx',
      fonts,
      loadCjkFont: async () => {
        cjkLoads += 1;
        return cjkFont;
      },
    });
    const extracted = await extractPdfText(result.pdfBytes);
    const compact = extracted.replace(/\s+/gu, '');
    assert.match(compact, /简体中文/u);
    assert.match(compact, /與繁體中文/u);
    assert.match(extracted, /cognitive neuroscience 2026/u);
    assert.match(compact, /測試/u);
    assert.equal(result.pageCount, 1);
    assert.ok(result.pdfTextCharacters >= 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(cjkLoads, 1);
  assert.equal(networkCalls, 0);
});

test('Chinese PPTX preserves mixed Han, Latin, punctuation, and numbers', async () => {
  const fixtureText = '中文認知神經科學 cognitive neuroscience 2026，測試。';
  const result = await engine.convertOfficeBytesToPdf({
    bytes: await createSimplePptxFixture({
      slideCount: 1,
      slideTexts: [fixtureText],
    }),
    expectedType: 'pptx',
    fonts,
    loadCjkFont: async () => cjkFont,
  });
  const extracted = await extractPdfText(result.pdfBytes);
  const compact = extracted.replace(/\s+/gu, '');
  assert.match(compact, /中文認知神經科學/u);
  assert.match(extracted, /cognitive neuroscience 2026/u);
  assert.match(compact, /，測試。/u);
  assert.equal(result.pageCount, 1);
});

test('the CJK asset is requested only for documents containing Han text', async () => {
  let loads = 0;
  const loadCjkFont = async () => {
    loads += 1;
    return cjkFont;
  };
  await engine.convertOfficeBytesToPdf({
    bytes: await createSimpleDocxFixture(),
    expectedType: 'docx',
    fonts,
    loadCjkFont,
  });
  assert.equal(loads, 0);
  await engine.convertOfficeBytesToPdf({
    bytes: await createSimplePptxFixture({
      slideCount: 1,
      slideTexts: ['中文 lazy font'],
    }),
    expectedType: 'pptx',
    fonts,
    loadCjkFont,
  });
  assert.equal(loads, 1);
  assert.doesNotMatch(
    source('../src/components/AppLayout.tsx'),
    /noto-sans-sc|NotoSansSC/u,
  );
  assert.match(
    source('../src/conversion/office/officeConversion.worker.ts'),
    /noto-sans-sc[\s\S]*loadCjkFont/u,
  );
});

test('explicitly hidden PPT text is the proven ghost layer and is removed structurally', async () => {
  const ghostText = 'Ghost overlay should not be visible';
  const sourceBytes = await createImageDominantPptxFixture({
    hiddenOverlay: true,
    overlayText: ghostText,
  });

  // Reamkit 1.29 ignores p:cNvPr@hidden and renders this source shape. This
  // assertion makes the upstream structural cause explicit instead of
  // guessing from image coverage.
  const unfiltered = await Ream.parse(sourceBytes).convert('pdf', {
    fonts,
    embedSource: false,
  });
  assert.match(
    await extractPdfText(unfiltered.buffer as ArrayBuffer),
    /Ghost overlay/u,
  );

  const sanitized =
    await pptxSanitizer.sanitizeHiddenPptxShapesForConversion(sourceBytes);
  assert.equal(sanitized.removedShapeCount, 1);
  assert.equal(sanitized.affectedSlideCount, 1);

  const result = await engine.convertOfficeBytesToPdf({
    bytes: sourceBytes,
    expectedType: 'pptx',
    fonts,
  });
  assert.equal(result.pageCount, 1);
  assert.equal(result.sourceTextCharacters, 0);
  assert.equal((await extractPdfText(result.pdfBytes)).trim(), '');
});

test('a full-slide image plus legitimate visible text remains selectable', async () => {
  const visibleText = 'Visible mixed-slide text stays searchable';
  const sourceBytes = await createImageDominantPptxFixture({
    hiddenOverlay: false,
    overlayText: visibleText,
  });
  const sanitized =
    await pptxSanitizer.sanitizeHiddenPptxShapesForConversion(sourceBytes);
  assert.equal(sanitized.removedShapeCount, 0);
  assert.strictEqual(sanitized.bytes, sourceBytes);

  const result = await engine.convertOfficeBytesToPdf({
    bytes: sourceBytes,
    expectedType: 'pptx',
    fonts,
  });
  assert.equal(result.pageCount, 1);
  assert.match(await extractPdfText(result.pdfBytes), /Visible mixed-slide text/u);
});

test('service ignores PDF.js outer-worker traffic and accepts only a validated transferable success', async () => {
  const originalWorker = globalThis.Worker;
  let receivedRequest: Record<string, unknown> | null = null;
  let responseBufferDetached = false;

  class FakeWorker extends EventTarget {
    terminated = false;

    postMessage(message: unknown, transfer: Transferable[]): void {
      const request = structuredClone(message, { transfer }) as Record<string, unknown>;
      receivedRequest = request;
      this.dispatchEvent(
        new MessageEvent('message', {
          data: {
            sourceName: 'worker',
            targetName: 'main',
            action: 'ready',
            data: null,
          },
        }),
      );
      const responsePort = request.responsePort as MessagePort;
      const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%%EOF').buffer;
      responsePort.postMessage(
        {
          protocol: officeTypes.OFFICE_CONVERSION_WORKER_PROTOCOL,
          requestId: request.requestId,
          kind: 'result',
          ok: true,
          pdfBytes,
          sourceType: 'docx',
          sourceTextCharacters: 12,
          pdfTextCharacters: 12,
          pageCount: 1,
          losses: {
            dropped: 0,
            degraded: 0,
            substituted: 0,
            unsupportedImagesOmitted: 0,
            metadataNormalizedImages: 0,
          },
        },
        [pdfBytes],
      );
      responseBufferDetached = pdfBytes.byteLength === 0;
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: FakeWorker,
    writable: true,
  });
  try {
    const input = new File([await createSimpleDocxFixture()], 'worker-boundary.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const result = await service.convertOfficeFileToPdf(input);

    assert.equal(result.file.name, 'worker-boundary.pdf');
    assert.equal(result.file.type, 'application/pdf');
    assert.equal(await result.file.slice(0, 5).text(), '%PDF-');
    assert.equal('pdfBytes' in result, false);
    assert.equal(responseBufferDetached, true);
    assert.ok(receivedRequest);
    assert.equal(
      receivedRequest.protocol,
      officeTypes.OFFICE_CONVERSION_WORKER_PROTOCOL,
    );
    assert.equal(receivedRequest.kind, 'convert');
    assert.equal(receivedRequest.expectedType, 'docx');
    assert.ok(receivedRequest.bytes instanceof ArrayBuffer);
    assert.ok(receivedRequest.responsePort instanceof MessagePort);
  } finally {
    restoreGlobalWorker(originalWorker);
  }
});

test('service rejects malformed namespaced success before reading pdfBytes', async () => {
  const originalWorker = globalThis.Worker;

  class FakeWorker extends EventTarget {
    postMessage(message: unknown, transfer: Transferable[]): void {
      const request = structuredClone(message, { transfer }) as Record<string, unknown>;
      (request.responsePort as MessagePort).postMessage({
        protocol: officeTypes.OFFICE_CONVERSION_WORKER_PROTOCOL,
        requestId: request.requestId,
        kind: 'result',
        ok: true,
        sourceType: 'docx',
      });
    }

    terminate(): void {}
  }

  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: FakeWorker,
    writable: true,
  });
  try {
    const input = new File([await createSimpleDocxFixture()], 'malformed.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await assert.rejects(service.convertOfficeFileToPdf(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'OfficeConversionError');
      assert.match(error.message, /invalid result/iu);
      assert.doesNotMatch(error.message, /pdfBytes|Cannot read properties/iu);
      return true;
    });
  } finally {
    restoreGlobalWorker(originalWorker);
  }
});

test('private response channel rejects foreign traffic instead of waiting for timeout', async () => {
  const originalWorker = globalThis.Worker;

  class FakeWorker extends EventTarget {
    postMessage(message: unknown, transfer: Transferable[]): void {
      const request = structuredClone(message, { transfer }) as Record<string, unknown>;
      (request.responsePort as MessagePort).postMessage({
        sourceName: 'worker',
        targetName: 'main',
        action: 'ready',
        data: null,
      });
    }

    terminate(): void {}
  }

  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: FakeWorker,
    writable: true,
  });
  try {
    const input = new File([await createSimpleDocxFixture()], 'foreign-response.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await assert.rejects(
      service.convertOfficeFileToPdf(input, { timeoutMs: 1_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid result/iu);
        assert.doesNotMatch(error.message, /timed out|pdfBytes/iu);
        return true;
      },
    );
  } finally {
    restoreGlobalWorker(originalWorker);
  }
});

test('service closes an untransferred response port when worker posting fails', async () => {
  const originalWorker = globalThis.Worker;
  const OriginalMessageChannel = globalThis.MessageChannel;
  let responsePortClosed = false;

  class TrackingMessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;

    constructor() {
      const channel = new OriginalMessageChannel();
      this.port1 = channel.port1;
      this.port2 = channel.port2;
      const close = this.port2.close.bind(this.port2);
      this.port2.close = () => {
        responsePortClosed = true;
        close();
      };
    }
  }

  class FakeWorker extends EventTarget {
    postMessage(): void {
      throw new DOMException('Transfer rejected.', 'DataCloneError');
    }

    terminate(): void {}
  }

  Object.defineProperties(globalThis, {
    MessageChannel: {
      configurable: true,
      value: TrackingMessageChannel,
      writable: true,
    },
    Worker: {
      configurable: true,
      value: FakeWorker,
      writable: true,
    },
  });
  try {
    const input = new File([await createSimplePptxFixture()], 'post-failure.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    await assert.rejects(service.convertOfficeFileToPdf(input), /invalid result/iu);
    assert.equal(responsePortClosed, true);
  } finally {
    restoreGlobalWorker(originalWorker);
    Object.defineProperty(globalThis, 'MessageChannel', {
      configurable: true,
      value: OriginalMessageChannel,
      writable: true,
    });
  }
});

test('worker failure is typed and no raw JavaScript TypeError reaches the service caller', async () => {
  const originalWorker = globalThis.Worker;

  class FakeWorker extends EventTarget {
    postMessage(message: unknown, transfer: Transferable[]): void {
      const request = structuredClone(message, { transfer }) as Record<string, unknown>;
      (request.responsePort as MessagePort).postMessage({
        protocol: officeTypes.OFFICE_CONVERSION_WORKER_PROTOCOL,
        requestId: request.requestId,
        kind: 'result',
        ok: false,
        error: {
          code: 'conversion-failed',
          message:
            'Conversion failed: the local Office converter stopped unexpectedly. Nothing was added.',
        },
      });
    }

    terminate(): void {}
  }

  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: FakeWorker,
    writable: true,
  });
  try {
    const input = new File([await createSimplePptxFixture()], 'failure.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    await assert.rejects(service.convertOfficeFileToPdf(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'OfficeConversionError');
      assert.match(error.message, /^Conversion failed:/u);
      assert.doesNotMatch(error.message, /pdfBytes|Cannot read properties/iu);
      return true;
    });
  } finally {
    restoreGlobalWorker(originalWorker);
  }
});

test('protocol decoder distinguishes foreign PDF.js traffic from malformed Office messages', () => {
  const foreign = protocol.decodeOfficeConversionResponse(
    {
      sourceName: 'worker',
      targetName: 'main',
      action: 'ready',
      data: null,
    },
    'request-1',
    'docx',
  );
  assert.equal(foreign.status, 'foreign');

  const malformed = protocol.decodeOfficeConversionResponse(
    {
      protocol: officeTypes.OFFICE_CONVERSION_WORKER_PROTOCOL,
      requestId: 'request-1',
      kind: 'result',
      ok: true,
      sourceType: 'docx',
      pdfBytes: undefined,
    },
    'request-1',
    'docx',
  );
  assert.equal(malformed.status, 'malformed');
});

test('unexpected engine errors serialize as safe converter failures', () => {
  const serialized = protocol.serializeOfficeConversionError(
    new TypeError("Cannot read properties of undefined (reading 'pdfBytes')"),
  );
  assert.equal(serialized.code, 'conversion-failed');
  assert.match(serialized.message, /^Conversion failed:/u);
  assert.doesNotMatch(serialized.message, /pdfBytes|Cannot read properties/iu);

  const expected = protocol.serializeOfficeConversionError(
    new validation.OfficeConversionError(
      'invalid-pdf',
      'The converter output failed PDF validation.',
    ),
  );
  assert.deepEqual(expected, {
    code: 'invalid-pdf',
    message: 'The converter output failed PDF validation.',
  });
});

test('conversion performs no external fetch and active content fails closed', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('Unexpected network access');
  }) as typeof fetch;
  try {
    await engine.convertOfficeBytesToPdf({
      bytes: await createSimpleDocxFixture({ includeExternalHyperlink: true }),
      expectedType: 'docx',
      fonts,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);

  const macroPptx = await createSimplePptxFixture({ macroEntry: true });
  await assert.rejects(() =>
    engine.convertOfficeBytesToPdf({
      bytes: macroPptx,
      expectedType: 'pptx',
      fonts,
    }),
  );
});

test('invalid Office selections and mismatched containers are rejected before import', async () => {
  assert.throws(
    () =>
      validation.validateOfficeFileSelection(
        new File(['not Office'], 'legacy.doc', { type: 'application/msword' }),
      ),
    /not supported/iu,
  );
  assert.equal(
    validation.createConvertedPdfFileName('Lecture 4.pptx'),
    'Lecture 4.pdf',
  );
  assert.equal(validation.createConvertedPdfFileName('Essay.docx'), 'Essay.pdf');

  await assert.rejects(
    () =>
      engine.convertOfficeBytesToPdf({
        bytes: new TextEncoder().encode('not a ZIP'),
        expectedType: 'docx',
        fonts,
      }),
    /ZIP|Office|package/iu,
  );
  const mismatchedPptx = await createSimplePptxFixture();
  await assert.rejects(
    () =>
      engine.convertOfficeBytesToPdf({
        bytes: mismatchedPptx,
        expectedType: 'docx',
        fonts,
      }),
    /not a valid DOCX|contents do not match/iu,
  );
});

test('Office conversion is lazy and normal UI has no direct Office reader route', () => {
  const app = source('../src/components/AppLayout.tsx');
  const dialog = source('../src/components/OfficePdfConverterDialog.tsx');
  const serviceSource = source('../src/conversion/office/service.ts');
  const worker = source('../src/conversion/office/officeConversion.worker.ts');
  const toolbar = source('../src/components/Toolbar.tsx');
  const coordinator = source('../src/sync/paperCoordinator.ts');

  assert.match(app, /prepared\.documentType !== 'pdf'/u);
  assert.match(app, /setOfficeConversionRequest/u);
  assert.match(
    app,
    /if \(prepared\.documentType !== 'pdf'\)[\s\S]*?setOfficeConversionRequest[\s\S]*?return;[\s\S]*?void flushPersistence\(\)/u,
  );
  assert.doesNotMatch(app, /<OfficeDocumentViewer/u);
  assert.doesNotMatch(app, /import\('\.\/OfficeDocumentViewer/u);
  assert.match(dialog, /await import\([\s\S]*office\/service/u);
  assert.match(dialog, /onImportPdf\(result\.file\)/u);
  assert.match(dialog, /downloadPdf\(result\.file\)/u);
  assert.doesNotMatch(dialog, /storeDocumentSource|saveDocumentState/u);
  assert.doesNotMatch(
    `${dialog}\n${serviceSource}\n${worker}`,
    /annotationPersistence|storeDocumentSource|saveDocumentState|upload.*Drive/iu,
  );
  assert.match(app, /onImportPdf=\{openDocument\}/u);
  assert.match(serviceSource, /new MessageChannel\(\)/u);
  assert.match(serviceSource, /decodeOfficeConversionResponse/u);
  assert.doesNotMatch(serviceSource, /finish\(\(\) => resolve\(data\.result\)\)/u);
  assert.match(worker, /new URL|same-origin/u);
  assert.match(worker, /fonts/u);
  assert.doesNotMatch(toolbar, /getDocumentAdapter/u);
  assert.match(coordinator, /assertPdfOnlyCloudPaper/u);
  assert.match(coordinator, /assertPdfOnlyLocalPublication/u);
});

test('Office-native sync publication and download fail closed without affecting PDF', () => {
  assert.doesNotThrow(() =>
    coordinator.assertPdfOnlyCloudPaper({
      documentId: 'pdf-cloud',
      sourceArtifact: { documentType: 'pdf' },
    } as never),
  );
  assert.throws(
    () =>
      coordinator.assertPdfOnlyCloudPaper({
        documentId: 'docx-cloud',
        sourceArtifact: { documentType: 'docx' },
      } as never),
    coordinator.OfficeNativePaperProductDisabledError,
  );
  assert.throws(
    () =>
      coordinator.assertPdfOnlyLocalPublication({
        documentId: 'pptx-local',
        sourceArtifact: { documentType: 'pptx' },
      } as never),
    coordinator.OfficeNativePaperProductDisabledError,
  );
  assert.doesNotThrow(() =>
    coordinator.assertPdfOnlyLocalPublication({
      documentId: 'pdf-local',
      sourceArtifact: { documentType: 'pdf' },
    } as never),
  );
});

function fontBytes(path: string): Uint8Array {
  return Uint8Array.from(readFileSync(new URL(path, import.meta.url)));
}

function restoreGlobalWorker(originalWorker: typeof Worker | undefined): void {
  if (originalWorker) {
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: originalWorker,
      writable: true,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, 'Worker');
}

async function assertPdfJsReadable(
  pdfBytes: ArrayBuffer,
  expectedText: RegExp,
): Promise<void> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: Uint8Array.from(new Uint8Array(pdfBytes)) });
  try {
    const document = await loadingTask.promise;
    assert.ok(document.numPages > 0);
    const firstPage = await document.getPage(1);
    const textContent = await firstPage.getTextContent();
    const text = textContent.items
      .flatMap((item) => ('str' in item ? [item.str] : []))
      .join(' ');
    assert.match(text, expectedText);
  } finally {
    await loadingTask.destroy();
  }
}

async function extractPdfText(pdfBytes: ArrayBuffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: Uint8Array.from(new Uint8Array(pdfBytes)) });
  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' '),
      );
      page.cleanup();
    }
    return pages.join('\n');
  } finally {
    await loadingTask.destroy();
  }
}
