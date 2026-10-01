export interface PrintComposerUiState {
  blocksDrawerOpen: boolean;
  formattingDrawerOpen: boolean;
  dismissedSourceChangeKey: string | null;
}

export type PrintComposerUiAction =
  | { type: 'toggle-blocks-drawer' }
  | { type: 'toggle-formatting-drawer' }
  | { type: 'close-blocks-drawer' }
  | { type: 'close-formatting-drawer' }
  | { type: 'close-drawers' }
  | { type: 'dismiss-source-change'; key: string };

export const INITIAL_PRINT_COMPOSER_UI_STATE: Readonly<PrintComposerUiState> = {
  blocksDrawerOpen: false,
  formattingDrawerOpen: false,
  dismissedSourceChangeKey: null,
};

export function reducePrintComposerUiState(
  state: PrintComposerUiState,
  action: PrintComposerUiAction,
): PrintComposerUiState {
  switch (action.type) {
    case 'toggle-blocks-drawer':
      return {
        ...state,
        blocksDrawerOpen: !state.blocksDrawerOpen,
        formattingDrawerOpen: false,
      };
    case 'toggle-formatting-drawer':
      return {
        ...state,
        blocksDrawerOpen: false,
        formattingDrawerOpen: !state.formattingDrawerOpen,
      };
    case 'close-blocks-drawer':
      return { ...state, blocksDrawerOpen: false };
    case 'close-formatting-drawer':
      return { ...state, formattingDrawerOpen: false };
    case 'close-drawers':
      return {
        ...state,
        blocksDrawerOpen: false,
        formattingDrawerOpen: false,
      };
    case 'dismiss-source-change':
      return { ...state, dismissedSourceChangeKey: action.key };
  }
}

export function createSourceChangeNoticeKey(
  sourceFingerprint: string,
  sourceModelVersion: number,
): string {
  return `${sourceModelVersion}:${sourceFingerprint}`;
}

export function shouldShowSourceChangeNotice(
  sourceChanged: boolean,
  sourceChangeKey: string,
  dismissedSourceChangeKey: string | null,
): boolean {
  return sourceChanged && sourceChangeKey !== dismissedSourceChangeKey;
}
