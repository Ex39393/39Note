export const TUTORIAL_CHAPTERS = [
  {
    id: 'import',
    shortLabel: 'Import',
    title: 'Import your first document',
    description:
      'Open a PDF directly in the Reader, or convert a modern Office file locally before importing it.',
    points: [
      'Use Import PDF or convert Office in Library; saved PDFs open with Read Now.',
      'DOCX and PPTX use Convert locally, then Add PDF to 39Note.',
      'Legacy .doc and .ppt files are not supported.',
    ],
    visualLabel:
      'A synthetic 39Note Library import view flowing into an opened PDF in the Reader.',
  },
  {
    id: 'annotate',
    shortLabel: 'Annotate',
    title: 'Annotate and connect ideas',
    description:
      'Select text in the PDF, then choose the study action that fits the passage.',
    points: [
      'Choose Highlight or Underline, pick a colour, then Apply; add a Note later from the mark’s Tag.',
      'Look up one selected word, then use Add to Glossary for the definition you want.',
      'Create a Link, connect its second passage, then use the matching numbered purple badges to move between them.',
    ],
    visualLabel:
      'Synthetic selected PDF text with 39Note Highlight, Underline, Link, Note, and Glossary controls.',
  },
  {
    id: 'organize',
    shortLabel: 'Organize',
    title: 'Organize your reading',
    description:
      'Use the Library to find papers quickly and Collections to group related reading.',
    points: [
      'Recent brings recently opened papers back into view.',
      'Pinned keeps important papers easy to reach.',
      'Collection view groups papers for browsing and opens them with Open.',
    ],
    visualLabel:
      'A populated synthetic 39Note Library beside the separate Collections view with fictional papers and Open actions.',
  },
  {
    id: 'protect',
    shortLabel: 'Protect',
    title: 'Keep your work safe',
    description:
      '39Note is local-first. Create regular Library backups and keep them somewhere durable.',
    points: [
      'PDF sources and editable study data are stored on this device.',
      'Back up Library creates a portable backup you can restore later.',
      'Restore backup inspects the package and asks how to handle conflicts.',
      'Clearing browser or site storage may remove local data, so keep backups somewhere durable.',
    ],
    visualLabel:
      'The synthetic 39Note Library showing the real Back up Library, Restore backup, and Storage action group above a clearly labeled conceptual backup diagram.',
  },
  {
    id: 'drive',
    shortLabel: 'Drive',
    title: 'Sync across your devices (optional)',
    description:
      'Connect Google Drive only when you want controlled sync for PDFs and study data.',
    points: [
      'Drive sync is optional; access must be requested and approved before connecting.',
      'After approval, connect from Google Drive. 39Note uses a managed 39Note folder.',
      'Reading locally does not require Drive, and connecting does not publish every pending change.',
      'Drive content is not end-to-end encrypted by 39Note.',
    ],
    visualLabel:
      'A clearly labeled synthetic demonstration of the 39Note Google Drive page showing Changes waiting, Auto sync, exact upload controls, and one paper with Local changes.',
  },
] as const;

export type TutorialChapterId = (typeof TUTORIAL_CHAPTERS)[number]['id'];
export type TutorialScreenId = 'cover' | TutorialChapterId | 'completion';
export type TutorialProgressState = 'complete' | 'current' | 'upcoming';

export const TUTORIAL_SCREEN_IDS: readonly TutorialScreenId[] = [
  'cover',
  ...TUTORIAL_CHAPTERS.map((chapter) => chapter.id),
  'completion',
];

export function isTutorialChapter(
  screenId: TutorialScreenId,
): screenId is TutorialChapterId {
  return TUTORIAL_CHAPTERS.some((chapter) => chapter.id === screenId);
}

export function getTutorialChapterNumber(screenId: TutorialScreenId): number | null {
  const index = TUTORIAL_CHAPTERS.findIndex((chapter) => chapter.id === screenId);
  return index < 0 ? null : index + 1;
}

export function getNextTutorialScreen(screenId: TutorialScreenId): TutorialScreenId {
  const index = TUTORIAL_SCREEN_IDS.indexOf(screenId);
  return TUTORIAL_SCREEN_IDS[Math.min(index + 1, TUTORIAL_SCREEN_IDS.length - 1)];
}

export function getPreviousTutorialScreen(
  screenId: TutorialScreenId,
): TutorialScreenId {
  const index = TUTORIAL_SCREEN_IDS.indexOf(screenId);
  return TUTORIAL_SCREEN_IDS[Math.max(index - 1, 0)];
}

export function getTutorialProgressState(
  screenId: TutorialScreenId,
  chapterId: TutorialChapterId,
): TutorialProgressState {
  if (screenId === 'completion') return 'complete';
  if (screenId === 'cover') return 'upcoming';
  const current = getTutorialChapterNumber(screenId) ?? 0;
  const candidate = getTutorialChapterNumber(chapterId) ?? 0;
  if (candidate < current) return 'complete';
  return candidate === current ? 'current' : 'upcoming';
}
