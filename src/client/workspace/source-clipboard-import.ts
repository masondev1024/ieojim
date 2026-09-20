export type ClipboardImportStatus = 'idle' | 'reading' | 'preview' | 'confirm_replace' | 'manual' | 'error';

export type ClipboardImportState = {
  status: ClipboardImportStatus;
  previewText: string;
  message: string | null;
  requestId: number;
  previewScopeKey: string | null;
  previewDraftVersion: string | null;
};

export type ClipboardImportReadResult =
  | { accepted: true; state: ClipboardImportState }
  | { accepted: false; state: ClipboardImportState };

export const initialClipboardImportState = (): ClipboardImportState => ({
  status: 'idle',
  previewText: '',
  message: null,
  requestId: 0,
  previewScopeKey: null,
  previewDraftVersion: null,
});

export function beginClipboardRead(state: ClipboardImportState, scopeKey: string): ClipboardImportState {
  return {
    ...state,
    status: 'reading',
    message: null,
    requestId: state.requestId + 1,
    previewScopeKey: scopeKey,
    previewDraftVersion: null,
  };
}

export function receiveClipboardText(
  state: ClipboardImportState,
  input: {
    requestId: number;
    requestedScopeKey: string;
    currentScopeKey: string;
    disabled: boolean;
    text: string;
    maxLength: number;
    draftVersion: string;
  },
): ClipboardImportReadResult {
  if (
    state.requestId !== input.requestId ||
    input.requestedScopeKey !== input.currentScopeKey ||
    input.disabled
  ) {
    return { accepted: false, state };
  }

  const text = input.text.trim();
  if (text.length === 0) {
    return {
      accepted: true,
      state: {
        ...state,
        status: 'error',
        previewText: '',
        message: '클립보드에 가져올 원문이 없습니다. 안내문 내용을 복사한 뒤 다시 눌러 주세요.',
        previewScopeKey: null,
        previewDraftVersion: null,
      },
    };
  }

  if (text.length > input.maxLength) {
    return {
      accepted: true,
      state: {
        ...state,
        status: 'error',
        previewText: text,
        message: `${text.length}/${input.maxLength}자입니다. 저장 한도를 넘어서 바로 가져올 수 없습니다. 필요한 부분만 줄여서 붙여넣어 주세요.`,
        previewScopeKey: input.currentScopeKey,
        previewDraftVersion: input.draftVersion,
      },
    };
  }

  return {
    accepted: true,
    state: {
      ...state,
      status: 'preview',
      previewText: text,
      message: `${text.length}자 원문을 읽었습니다. 내용을 확인한 뒤 가져오세요.`,
      previewScopeKey: input.currentScopeKey,
      previewDraftVersion: input.draftVersion,
    },
  };
}

export function failClipboardRead(
  state: ClipboardImportState,
  input: { requestId: number; requestedScopeKey: string; currentScopeKey: string; disabled: boolean },
): ClipboardImportReadResult {
  if (
    state.requestId !== input.requestId ||
    input.requestedScopeKey !== input.currentScopeKey ||
    input.disabled
  ) {
    return { accepted: false, state };
  }
  return {
    accepted: true,
    state: {
      ...state,
      status: 'manual',
      previewText: '',
      message: '브라우저가 클립보드 읽기를 허용하지 않았습니다. 아래 원문 입력칸에 직접 붙여넣어 주세요.',
      previewScopeKey: null,
      previewDraftVersion: null,
    },
  };
}

export function requestClipboardImport(
  state: ClipboardImportState,
  input: { scopeKey: string; draftVersion: string; hasDraft: boolean; disabled: boolean; maxLength: number },
): { action: 'import'; text: string; state: ClipboardImportState } | { action: 'wait' | 'blocked'; state: ClipboardImportState } {
  const overLimit = state.previewText.length > input.maxLength;
  if (
    input.disabled ||
    state.previewText.length === 0 ||
    overLimit ||
    state.previewScopeKey !== input.scopeKey ||
    state.previewDraftVersion !== input.draftVersion
  ) {
    return {
      action: 'blocked',
      state: {
        ...state,
        status: 'error',
        message: overLimit
          ? `${state.previewText.length}/${input.maxLength}자입니다. 저장 한도 안으로 줄인 뒤 가져오세요.`
          : '작성 중인 원문이 바뀌었습니다. 클립보드 내용을 다시 확인해 주세요.',
      },
    };
  }

  if (input.hasDraft && state.status !== 'confirm_replace') {
    return {
      action: 'wait',
      state: {
        ...state,
        status: 'confirm_replace',
        message: '이미 작성 중인 원문이 있습니다. 가져오면 지금 입력한 내용이 바뀝니다.',
      },
    };
  }

  return {
    action: 'import',
    text: state.previewText,
    state: {
      ...initialClipboardImportState(),
      requestId: state.requestId + 1,
      message: '클립보드 원문을 입력칸에 가져왔습니다.',
    },
  };
}

export function resetClipboardImport(state: ClipboardImportState): ClipboardImportState {
  return {
    ...initialClipboardImportState(),
    requestId: state.requestId + 1,
  };
}
