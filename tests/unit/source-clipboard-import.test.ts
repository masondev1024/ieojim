import { describe, expect, it } from 'vitest';
import {
  beginClipboardRead,
  failClipboardRead,
  initialClipboardImportState,
  receiveClipboardText,
  requestClipboardImport,
} from '../../src/client/workspace/source-clipboard-import';

describe('source clipboard import controller', () => {
  it('keeps clipboard reads explicit and imports only after preview approval', () => {
    const reading = beginClipboardRead(initialClipboardImportState(), 'workspace-a:1');

    const received = receiveClipboardText(reading, {
      requestId: reading.requestId,
      requestedScopeKey: 'workspace-a:1',
      currentScopeKey: 'workspace-a:1',
      disabled: false,
      text: '  새 안내문입니다.  ',
      maxLength: 100,
      draftVersion: '',
    });

    expect(received.accepted).toBe(true);
    expect(received.state).toMatchObject({
      status: 'preview',
      previewText: '새 안내문입니다.',
      previewScopeKey: 'workspace-a:1',
    });

    const imported = requestClipboardImport(received.state, {
      scopeKey: 'workspace-a:1',
      draftVersion: '',
      hasDraft: false,
      disabled: false,
      maxLength: 100,
    });

    expect(imported).toMatchObject({ action: 'import', text: '새 안내문입니다.' });
    expect(imported.state.previewText).toBe('');
  });

  it('requires a second approval before replacing a draft', () => {
    const reading = beginClipboardRead(initialClipboardImportState(), 'workspace-a:1');
    const received = receiveClipboardText(reading, {
      requestId: reading.requestId,
      requestedScopeKey: 'workspace-a:1',
      currentScopeKey: 'workspace-a:1',
      disabled: false,
      text: '정정 안내문',
      maxLength: 100,
      draftVersion: '사용자가 쓰던 초안',
    }).state;

    const first = requestClipboardImport(received, {
      scopeKey: 'workspace-a:1',
      draftVersion: '사용자가 쓰던 초안',
      hasDraft: true,
      disabled: false,
      maxLength: 100,
    });
    expect(first.action).toBe('wait');
    expect(first.state.status).toBe('confirm_replace');

    const second = requestClipboardImport(first.state, {
      scopeKey: 'workspace-a:1',
      draftVersion: '사용자가 쓰던 초안',
      hasDraft: true,
      disabled: false,
      maxLength: 100,
    });
    expect(second).toMatchObject({ action: 'import', text: '정정 안내문' });
  });

  it('rejects empty and over-limit clipboard text before import', () => {
    const emptyRead = beginClipboardRead(initialClipboardImportState(), 'workspace-a:1');
    const empty = receiveClipboardText(emptyRead, {
      requestId: emptyRead.requestId,
      requestedScopeKey: 'workspace-a:1',
      currentScopeKey: 'workspace-a:1',
      disabled: false,
      text: '   ',
      maxLength: 10,
      draftVersion: '',
    }).state;

    expect(empty.status).toBe('error');
    expect(empty.previewText).toBe('');

    const longRead = beginClipboardRead(initialClipboardImportState(), 'workspace-a:1');
    const tooLong = receiveClipboardText(longRead, {
      requestId: longRead.requestId,
      requestedScopeKey: 'workspace-a:1',
      currentScopeKey: 'workspace-a:1',
      disabled: false,
      text: '12345678901',
      maxLength: 10,
      draftVersion: '',
    }).state;

    expect(tooLong.status).toBe('error');
    expect(tooLong.previewText).toBe('12345678901');
    expect(requestClipboardImport(tooLong, {
      scopeKey: 'workspace-a:1',
      draftVersion: '',
      hasDraft: false,
      disabled: false,
      maxLength: 10,
    }).action).toBe('blocked');
  });

  it('ignores late clipboard responses after scope or disabled state changes', () => {
    const reading = beginClipboardRead(initialClipboardImportState(), 'workspace-a:1');

    const switched = receiveClipboardText(reading, {
      requestId: reading.requestId,
      requestedScopeKey: 'workspace-a:1',
      currentScopeKey: 'workspace-b:1',
      disabled: false,
      text: '늦게 도착한 안내',
      maxLength: 100,
      draftVersion: '',
    });
    expect(switched.accepted).toBe(false);
    expect(switched.state.status).toBe('reading');
    expect(switched.state.previewText).toBe('');

    const disabled = failClipboardRead(reading, {
      requestId: reading.requestId,
      requestedScopeKey: 'workspace-a:1',
      currentScopeKey: 'workspace-a:1',
      disabled: true,
    });
    expect(disabled.accepted).toBe(false);
    expect(disabled.state.status).toBe('reading');
  });

  it('blocks stale preview import when the draft changed after reading', () => {
    const reading = beginClipboardRead(initialClipboardImportState(), 'workspace-a:1');
    const preview = receiveClipboardText(reading, {
      requestId: reading.requestId,
      requestedScopeKey: 'workspace-a:1',
      currentScopeKey: 'workspace-a:1',
      disabled: false,
      text: '정정 안내',
      maxLength: 100,
      draftVersion: 'old draft',
    }).state;

    const result = requestClipboardImport(preview, {
      scopeKey: 'workspace-a:1',
      draftVersion: 'new draft',
      hasDraft: true,
      disabled: false,
      maxLength: 100,
    });

    expect(result.action).toBe('blocked');
    expect(result.state.message).toContain('작성 중인 원문이 바뀌었습니다');
  });
});
