// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Cải trang cai ngục (bộ đồ cai ngục). Mặc vào là "thành cai ngục":
 * - Cai ngục, camera, tháp canh KHÔNG BAO GIỜ nhận ra danh tính (không kiểm tra mã, không hỏi đáp,
 *   không xác suất theo bẩn / rách / ngày đêm).
 * - Không bị truy nã vì ở ngoài xà lim sau 21:00, không vi phạm vì ở khu cấm.
 * - Chỉ mất cải trang (tạm thời) khi bị THẤY làm hành vi phạm tội: đánh nhau, đào, phá hoại, lục soát,
 *   cầm vũ khí lộ… Khi đó cai ngục báo động như với tù nhân.
 * Thông số ở data/disguise.json.
 */
import disguiseJson from './data/disguise.json';
import { isDisguised } from './gear';
import { PRISON_MAP, zoneAt } from './map';
import { emit, journal } from './rules';
import type {
  ActionResult,
  ErrorCode,
  GuardEntity,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

export const DISGUISE = disguiseJson;

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});
const REVOKED = '__exposed';

/** Đang mặc bộ đồ cai ngục và chưa bị mất cải trang gần đây */
export function disguiseActive(
  world: Pick<WorldState, 'time'>,
  p: Pick<PlayerState, 'gear' | 'disguiseChecks'>,
): boolean {
  if (!isDisguised(p)) return false;
  const at = p.disguiseChecks[REVOKED];
  return at === undefined || world.time - at >= DISGUISE.revokeSeconds;
}

/** Bị thấy phạm tội khi đang cải trang: mất lớp cải trang tạm thời (bộ đồ coi là đồ cấm, bị tịch thu nếu bị bắt) */
export function exposeDisguise(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  by: string,
  reason: string,
): void {
  if (!DISGUISE.revokedOnCrimeSeen) return;
  p.disguiseChecks[REVOKED] = world.time;
  delete world.challenges[p.id];
  p.stats.personalHeat = 100;
  out.dirtyInventories.add(p.id);
  const zone =
    PRISON_MAP.zones.find((z) => z.id === zoneAt(PRISON_MAP, p.x, p.y))?.name ??
    '?';
  journal(
    world,
    out,
    'violation',
    `${by} thấy ${p.name} (mặc đồ cai ngục) ${reason} ở ${zone} — mất cải trang`,
    p.id,
  );
  emit(world, out, {
    type: 'disguise:blown',
    playerId: p.id,
    x: p.x,
    y: p.y,
    text: `⚠️ ${by} thấy ${p.name} ${reason} — báo động!`,
  });
}

export type DisguiseCheck = 'pass' | 'exposed';

/**
 * Cai ngục `g` nhìn thấy người mặc đồ cai ngục: danh tính luôn qua; chỉ khi đang phạm tội (`crime`)
 * mới mất cải trang. Giữ chữ ký cũ để AI cai ngục gọi như trước.
 */
export function checkDisguise(
  world: WorldState,
  out: Outbox,
  g: GuardEntity,
  p: PlayerState,
  _d: number,
  crime?: string,
): DisguiseCheck {
  if (!crime) return 'pass';
  exposeDisguise(world, out, p, g.name, crime);
  return 'exposed';
}

/** Không còn hỏi đáp đồng nghiệp — giữ action để client cũ không lỗi */
export function answerChallenge(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  _choice: number,
): ActionResult {
  delete world.challenges[p.id];
  return fail('INVALID_STATE', 'Không có ai đang hỏi bạn');
}

/** Không còn hỏi đáp: dọn các câu hỏi cũ (từ bản lưu cũ) */
export function updateChallenges(
  world: WorldState,
  _out: Outbox,
): { p: PlayerState; g: GuardEntity | undefined }[] {
  for (const pid of Object.keys(world.challenges)) delete world.challenges[pid];
  return [];
}
