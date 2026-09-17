import { describe, expect, it } from 'vitest';
import { createMaterialsDemo } from '../../src/client/landing/materials-demo-model';

describe('realistic materials demo uses actual core transitions', () => {
  it('preserves user decisions while flagging previously completed changed work', async () => {
    const demo = await createMaterialsDemo();
    expect(demo.before).toMatchObject({ completed: true, stale: false });
    expect(demo.after).toMatchObject({ id: demo.before.id, completed: true, stale: true, preparation: demo.before.preparation });
    expect(demo.after.value).toContain('수정본');
    expect(demo.protectedAppointment).toMatchObject({ value: '2026-09-24 09:00', locked: true, stale: false });
    expect(demo.note).toMatchObject({ value: '견적 금액은 담당자 확인 후 전달하기', edited: true, stale: true });
    expect(demo.review('reopen')).toMatchObject({ completed: false, stale: false, preparation: demo.before.preparation });
    expect(demo.review('keep_completed')).toMatchObject({ completed: true, stale: false });
    expect(demo.after).toMatchObject({ completed: true, stale: true });
  });
});
