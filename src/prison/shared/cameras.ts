// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Camera an ninh: quét qua lại theo thời gian (tất định, client tự tính góc), bị tường che. */
import { PRISON_CONFIG as C } from './config';
import { angleDiff, dist, hasLineOfSight } from './geometry';
import { PRISON_MAP, type CameraDef } from './map';
import { disguiseActive, exposeDisguise } from './disguise';
import { emit, recordViolation, violationOf } from './rules';
import type { Outbox, PlayerState, WorldState } from './types';

export function cameraAngle(cam: CameraDef, time: number): number {
  return cam.angle + cam.sweep * Math.sin((2 * Math.PI * time) / cam.period);
}

export function camerasActive(
  world: Pick<WorldState, 'time' | 'camerasOffUntil'>,
): boolean {
  return world.time >= world.camerasOffUntil;
}

export function cameraSees(
  cam: CameraDef,
  time: number,
  x: number,
  y: number,
): boolean {
  const d = dist(cam.x, cam.y, x, y);
  // vùng mù ngay chân tường dưới camera
  if (d > cam.range || d < cam.blindRadius) return false;
  const a = Math.atan2(y - cam.y, x - cam.x);
  if (Math.abs(angleDiff(a, cameraAngle(cam, time))) > cam.fov / 2)
    return false;
  return hasLineOfSight(PRISON_MAP, cam.x, cam.y, x, y);
}

/** Trả về các người chơi bị camera nhìn thấy đang vi phạm nghiêm trọng (người giả dạng không bị camera nhận ra) */
export function updateCameras(
  world: WorldState,
  out: Outbox,
  dt: number,
  onAlarm: (p: PlayerState) => void,
): void {
  if (!camerasActive(world)) return;
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (
      !p ||
      p.status !== 'ACTIVE' ||
      !p.connected ||
      p.vehicle ||
      p.underground
    )
      continue;
    // camera coi người mặc đồ cai ngục là cai ngục: chỉ ghi hình khi đang phạm tội
    const disguised = disguiseActive(world, p);
    const crime = violationOf(world, p, disguised);
    const v = disguised
      ? crime
        ? { ...crime, severity: 'serious' as const }
        : null
      : crime;
    if (!v || v.severity !== 'serious') continue;
    const cam = PRISON_MAP.cameras.find((c) =>
      cameraSees(c, world.time, p.x, p.y),
    );
    if (!cam) continue;
    p.stats.personalHeat = Math.min(
      100,
      p.stats.personalHeat + C.heat.cameraPersonalPerSecond * dt,
    );
    world.teamHeat = Math.min(
      100,
      world.teamHeat + C.heat.cameraTeamPerSecond * dt,
    );
    const camKey = `cam:${v.key}`;
    if (!p.violationKeys.includes(camKey)) {
      if (disguised) exposeDisguise(world, out, p, 'Camera', v.reason);
      recordViolation(world, out, p, { ...v, key: camKey }, 'Camera');
      emit(world, out, {
        type: 'camera:spotted',
        playerId: p.id,
        x: p.x,
        y: p.y,
        text: `📹 Camera ghi hình ${p.name}!`,
      });
      onAlarm(p);
    }
  }
}
