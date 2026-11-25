/** Model Mongoose được giả lập (không có MongoDB trong môi trường test) — kiểm tra truy vấn & chính sách */
import { Types } from 'mongoose';
import { PrisonPersistenceService } from './prison-persistence.service';
import { createWorld } from './shared/world';

function setup() {
  let stored = { checkpointVersion: 0 };
  const updateOne = jest.fn(
    (
      filter: { checkpointVersion: { $lt: number } },
      update: { $set: { checkpointVersion: number } },
    ) => {
      // mô phỏng điều kiện $lt của MongoDB
      const ok = stored.checkpointVersion < filter.checkpointVersion.$lt;
      if (ok) stored = { checkpointVersion: update.$set.checkpointVersion };
      return Promise.resolve({ modifiedCount: ok ? 1 : 0 });
    },
  );
  const insertMany = jest.fn(() => Promise.resolve([]));
  const sessions = {
    updateOne,
    create: jest.fn(() => Promise.resolve({ _id: new Types.ObjectId() })),
  };
  const events = { insertMany };
  const svc = new PrisonPersistenceService(sessions as never, events as never);
  return {
    svc,
    updateOne,
    insertMany,
    get stored() {
      return stored;
    },
  };
}

const world = () =>
  createWorld({
    seed: 1,
    difficulty: 'NORMAL',
    mode: 'multi',
    players: [{ id: 'a', name: 'A', role: 'HACKER' }],
  });

describe('PrisonPersistenceService', () => {
  afterEach(() => jest.clearAllTimers());

  it('checkpoint có điều kiện version: checkpoint cũ đến muộn không ghi đè bản mới', async () => {
    const t = setup();
    const id = String(new Types.ObjectId());
    expect(await t.svc.saveCheckpoint(id, 2, world())).toBe(true);
    expect(await t.svc.saveCheckpoint(id, 1, world())).toBe(false);
    expect(t.stored.checkpointVersion).toBe(2);
    expect(t.updateOne.mock.calls[1][0]).toMatchObject({
      checkpointVersion: { $lt: 1 },
    });
    await t.svc.onModuleDestroy();
  });

  it('chỉ đưa sự kiện audit vào hàng đợi; ghi theo lô, bỏ qua lỗi trùng khoá (retry an toàn)', async () => {
    const t = setup();
    const id = String(new Types.ObjectId());
    t.svc.queueEvents(id, [
      { id: 'ev1', type: 'player:trade-completed', audit: true },
      { id: 'ev2', type: 'game:clock-updated' },
    ]);
    await t.svc.flush();
    expect(t.insertMany).toHaveBeenCalledTimes(1);
    const firstCall = t.insertMany.mock.calls[0] as unknown as [
      { eventId: string }[],
    ];
    expect(firstCall[0].map((e) => e.eventId)).toEqual(['ev1']);
    t.insertMany.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('dup'), { code: 11000 })),
    );
    t.svc.queueEvents(id, [{ id: 'ev1', type: 'x', audit: true }]);
    await expect(t.svc.flush()).resolves.toBeUndefined();
    await t.svc.onModuleDestroy();
  });

  it('sessionId không hợp lệ -> không ghi', async () => {
    const t = setup();
    expect(await t.svc.saveCheckpoint('nope', 1, world())).toBe(false);
    t.svc.queueEvents('nope', [{ id: 'e', type: 't', audit: true }]);
    await t.svc.flush();
    expect(t.insertMany).not.toHaveBeenCalled();
    await t.svc.onModuleDestroy();
  });
});
