import {
  PrisonSimulationService,
  RoomSimulation,
  type SimulationHooks,
} from './prison-simulation';
import { createWorld } from './shared/world';
import type { WorldState } from './shared/types';

function makeHooks() {
  const calls = {
    snapshots: 0,
    keyframes: 0,
    events: [] as string[],
    privates: [] as string[],
    meta: 0,
    checkpoints: [] as string[],
    outcome: 0,
    fatal: 0,
  };
  const hooks: SimulationHooks = {
    snapshot: (s) => {
      calls.snapshots++;
      if (s.keyframe) calls.keyframes++;
    },
    events: (e) => calls.events.push(...e.map((x) => x.type)),
    privateState: (pid) => calls.privates.push(pid),
    teamStorage: () => {},
    meta: () => calls.meta++,
    checkpoint: (_w, reason) => calls.checkpoints.push(reason),
    outcome: () => calls.outcome++,
    fatal: () => calls.fatal++,
  };
  return { hooks, calls };
}

const fakeClock = () => {
  let fn: (() => void) | null = null;
  return {
    now: () => 0,
    setInterval: (f: () => void) => {
      fn = f;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
    run: (n: number) => {
      for (let i = 0; i < n; i++) fn?.();
    },
    get active() {
      return fn !== null;
    },
  };
};

function world2(): WorldState {
  const w = createWorld({
    seed: 1,
    difficulty: 'NORMAL',
    mode: 'multi',
    players: [
      { id: 'a', name: 'A', role: 'HACKER' },
      { id: 'b', name: 'B', role: 'SCOUT' },
    ],
  });
  w.guards = [];
  return w;
}

describe('RoomSimulation', () => {
  it('tick tiến đều, snapshot 10/s (mỗi 2 tick), keyframe mỗi 5 giây, checkpoint 30 giây', () => {
    const { hooks, calls } = makeHooks();
    const clock = fakeClock();
    const sim = new RoomSimulation('ROOM1', world2(), hooks, clock);
    sim.start();
    clock.run(20 * 31);
    expect(sim.world.tick).toBe(620);
    expect(calls.snapshots).toBe(310);
    expect(calls.keyframes).toBe(7);
    expect(calls.checkpoints).toEqual(['interval']);
    sim.stop();
    expect(clock.active).toBe(false);
  });

  it('input: bỏ trùng/out-of-order, giới hạn số input xử lý mỗi tick', () => {
    const { hooks } = makeHooks();
    const clock = fakeClock();
    const sim = new RoomSimulation('ROOM1', world2(), hooks, clock);
    sim.start();
    expect(
      sim.enqueueInput('a', {
        sequence: 2,
        directionX: 1,
        directionY: 0,
        sprint: false,
      }),
    ).toBe(true);
    expect(
      sim.enqueueInput('a', {
        sequence: 2,
        directionX: 1,
        directionY: 0,
        sprint: false,
      }),
    ).toBe(false);
    expect(
      sim.enqueueInput('a', {
        sequence: 1,
        directionX: 1,
        directionY: 0,
        sprint: false,
      }),
    ).toBe(false);
    expect(
      sim.enqueueInput('ghost', {
        sequence: 5,
        directionX: 1,
        directionY: 0,
        sprint: false,
      }),
    ).toBe(false);
    for (let s = 3; s <= 10; s++)
      sim.enqueueInput('a', {
        sequence: s,
        directionX: 0,
        directionY: 1,
        sprint: false,
      });
    clock.run(1);
    expect(sim.world.players.a.lastSeq).toBe(4); // tối đa 3 input / tick
    clock.run(3);
    expect(sim.world.players.a.lastSeq).toBe(10);
  });

  it('thao tác commit rồi mới phát sự kiện riêng tư; retry cùng requestId trả kết quả cũ', () => {
    const { hooks, calls } = makeHooks();
    const sim = new RoomSimulation('ROOM1', world2(), hooks, fakeClock());
    const r1 = sim.action(
      'a',
      {
        type: 'questContribute',
        questId: 't_supplies',
        objectiveId: 'food',
        quantity: 1,
      },
      'req-000001',
    );
    expect(r1.ok).toBe(true);
    expect(calls.privates).toContain('a');
    const r2 = sim.action(
      'a',
      {
        type: 'questContribute',
        questId: 't_supplies',
        objectiveId: 'food',
        quantity: 1,
      },
      'req-000001',
    );
    expect(r2.duplicate).toBe(true);
    expect(sim.world.teamQuests.t_supplies.objectiveProgress.food).toBe(1);
  });

  it('lỗi trong tick bị cô lập; 5 lỗi liên tiếp -> tạm dừng phòng + fatal', () => {
    const { hooks, calls } = makeHooks();
    const clock = fakeClock();
    const w = world2();
    const sim = new RoomSimulation('ROOM1', w, hooks, clock);
    // làm hỏng dữ liệu để tick ném lỗi
    (w as unknown as { playerOrder: unknown }).playerOrder = null;
    sim.start();
    clock.run(4);
    expect(calls.fatal).toBe(0);
    clock.run(1);
    expect(calls.fatal).toBe(1);
    expect(sim.paused).toBe(true);
  });

  it('kết thúc trận: dừng loop, checkpoint "outcome", gọi outcome đúng 1 lần', () => {
    const { hooks, calls } = makeHooks();
    const clock = fakeClock();
    const w = world2();
    for (const p of Object.values(w.players)) p.status = 'ESCAPED';
    w.escape.status = 'EXECUTING';
    const sim = new RoomSimulation('ROOM1', w, hooks, clock);
    sim.start();
    clock.run(3);
    expect(w.outcome).toBe('ALL_ESCAPED');
    expect(calls.outcome).toBe(1);
    expect(calls.checkpoints).toContain('outcome');
    expect(clock.active).toBe(false);
    expect(calls.events).toContain('escape:team-victory');
  });

  it('tạm dừng: không tick', () => {
    const { hooks } = makeHooks();
    const clock = fakeClock();
    const sim = new RoomSimulation('ROOM1', world2(), hooks, clock);
    sim.start();
    sim.pause();
    clock.run(10);
    expect(sim.world.tick).toBe(0);
    sim.resume();
    clock.run(2);
    expect(sim.world.tick).toBe(2);
  });
});

describe('PrisonSimulationService', () => {
  it('chặn hai simulation owner cho cùng một phòng; dọn dẹp khi huỷ', () => {
    const svc = new PrisonSimulationService();
    const { hooks } = makeHooks();
    const clock = fakeClock();
    const sim = svc.create('ROOM1', world2(), hooks, clock);
    sim.start();
    expect(() => svc.create('ROOM1', world2(), hooks, clock)).toThrow(
      /simulation owner/,
    );
    svc.destroy('ROOM1');
    expect(svc.get('ROOM1')).toBeUndefined();
    expect(clock.active).toBe(false);
    expect(() =>
      svc.create('ROOM1', world2(), hooks, fakeClock()),
    ).not.toThrow();
    svc.onModuleDestroy();
    expect(svc.count()).toBe(0);
  });
});
