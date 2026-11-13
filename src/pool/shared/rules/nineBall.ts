// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import type { ShotResult } from '../physics/types';
import {
  ensureCue,
  lowestBall,
  msg,
  offTableText,
  other,
  potted,
  respot,
} from './common';
import type {
  RackState,
  RuleMessage,
  ShotDeclaration,
  ShotVerdict,
} from './types';

/**
 * TRỌNG TÀI 9 BI (WPA) — hàm thuần.
 * Bi cái phải chạm bi số nhỏ nhất trước, sau đó có bi vào lỗ hoặc có bi chạm băng.
 * Không cần gọi bi; bi 9 vào trong cú đánh hợp lệ (kể cả combo, kể cả khi phá) -> thắng.
 */
export function resolveNine(
  rack: RackState,
  decl: ShotDeclaration,
  res: ShotResult,
  names: [string, string],
): ShotVerdict {
  const shooter = rack.turn;
  const opp = other(shooter);
  const me = names[shooter];
  const them = names[opp];
  const pots = potted(res);
  const nineIn = pots.includes(9);
  // Bi 9 văng khỏi bàn: lỗi, nhưng bi 9 được đặt lại như khi vào lỗ phạm lỗi
  const nineOff = res.offTable.includes(9);
  const low = lowestBall(rack.balls);
  const messages: RuleMessage[] = [];
  const base: RackState = {
    ...rack,
    balls: res.final,
    shotNo: rack.shotNo + 1,
    ballInHand: null,
    restrictToFrontOfHeadString: false,
  };

  /** Áp lỗi: đặt lại bi 9 nếu vào, cộng lỗi liên tiếp, 3 lỗi -> thua */
  const applyFoul = (
    foul: string,
    extra: Partial<RackState> = {},
  ): ShotVerdict => {
    let balls = res.final;
    if (nineIn || nineOff) balls = respot(balls, 9);
    const fouls: [number, number] = [...rack.fouls];
    fouls[shooter] += 1;
    if (fouls[shooter] >= 3) {
      messages.push(
        msg('foul', `Lỗi: ${foul}. ${me} phạm 3 lỗi liên tiếp — thua ván!`),
      );
      return {
        rack: {
          ...base,
          ...extra,
          balls,
          fouls,
          winner: opp,
          winReason: 'Đối thủ phạm 3 lỗi liên tiếp',
        },
        messages,
        foul,
        continues: false,
      };
    }
    messages.push(
      msg(
        'foul',
        `Lỗi: ${foul}${nineIn || nineOff ? ' (bi 9 được đặt lại)' : ''} — ${them} được bi trong tay`,
      ),
    );
    if (fouls[shooter] === 2)
      messages.push(
        msg(
          'warn',
          `⚠️ ${me} đang có 2 lỗi liên tiếp — thêm 1 lỗi nữa sẽ thua ván`,
        ),
      );
    return {
      rack: {
        ...base,
        ...extra,
        balls: ensureCue(balls, false),
        fouls,
        turn: opp,
        ballInHand: 'table',
      },
      messages,
      foul,
      continues: false,
    };
  };

  const clearFouls = (): [number, number] => {
    const f: [number, number] = [...rack.fouls];
    f[shooter] = 0;
    return f;
  };

  // ================= CÚ PHÁ =================
  if (rack.isBreak) {
    const legalBreak = pots.length > 0 || res.objectBallsToCushion.length >= 4;
    let foul: string | null = null;
    if (res.scratch) foul = 'Bi cái rơi lỗ khi phá';
    else if (res.offTable.length) foul = `${offTableText(res)} khi phá`;
    else if (res.firstHit !== 1)
      foul =
        res.firstHit === null
          ? 'Bi cái không chạm bi nào khi phá'
          : `Phá phải chạm bi 1 trước (chạm bi ${res.firstHit})`;
    else if (!legalBreak)
      foul = `Phá không hợp lệ: không bi nào vào và chỉ ${res.objectBallsToCushion.length} bi chạm băng (cần 4)`;
    if (foul)
      return applyFoul(foul, { isBreak: false, pushOutAvailable: true });
    if (nineIn) {
      messages.push(msg('win', `Bi 9 vào lỗ ngay cú phá — ${me} thắng ván!`));
      return {
        rack: {
          ...base,
          isBreak: false,
          fouls: clearFouls(),
          winner: shooter,
          winReason: 'Bi 9 vào khi phá',
        },
        messages,
        foul: null,
        continues: false,
      };
    }
    const cont = pots.length > 0;
    messages.push(
      cont
        ? msg(
            'good',
            `Phá hợp lệ, ${pots.length} bi vào — ${me} đánh tiếp (có thể push out)`,
          )
        : msg('info', `Phá hợp lệ — tới lượt ${them} (có thể push out)`),
    );
    return {
      rack: {
        ...base,
        isBreak: false,
        fouls: clearFouls(),
        pushOutAvailable: true,
        turn: cont ? shooter : opp,
      },
      messages,
      foul: null,
      continues: cont,
    };
  }

  // ================= PUSH OUT =================
  if (decl.pushOut && rack.pushOutAvailable) {
    if (res.scratch || res.offTable.length)
      return applyFoul(
        res.scratch
          ? 'Bi cái rơi lỗ khi push out'
          : `${offTableText(res)} khi push out`,
        {
          pushOutAvailable: false,
        },
      );
    // Bi vào khi push out không tính (vẫn nằm dưới lỗ), riêng bi 9 được đặt lại
    const balls = nineIn || nineOff ? respot(res.final, 9) : res.final;
    messages.push(
      msg(
        'info',
        `${me} push out${pots.length ? ` (${pots.length} bi vào không tính${nineIn ? ', bi 9 đặt lại' : ''})` : ''} — ${them} chọn đánh hay nhường lại`,
      ),
    );
    return {
      rack: {
        ...base,
        balls,
        fouls: clearFouls(),
        pushOutAvailable: false,
        turn: opp,
        decision: { kind: 'pushOutResponse', by: opp },
      },
      messages,
      foul: null,
      continues: false,
    };
  }

  // ================= CÚ ĐÁNH THƯỜNG =================
  let foul: string | null = null;
  if (res.scratch) foul = 'Bi cái rơi lỗ';
  else if (res.offTable.length) foul = offTableText(res);
  else if (res.firstHit === null) foul = 'Bi cái không chạm bi nào';
  else if (res.firstHit !== low)
    foul = `Phải chạm bi ${low} (số nhỏ nhất) trước, nhưng chạm bi ${res.firstHit}`;
  else if (pots.length === 0 && res.cushionAfterContact.length === 0)
    foul = 'Không có bi nào chạm băng sau va chạm';
  if (foul) return applyFoul(foul, { pushOutAvailable: false });

  if (nineIn) {
    messages.push(msg('win', `Bi 9 vào lỗ — ${me} thắng ván!`));
    return {
      rack: {
        ...base,
        fouls: clearFouls(),
        pushOutAvailable: false,
        winner: shooter,
        winReason: 'Đưa bi 9 vào lỗ hợp lệ',
      },
      messages,
      foul: null,
      continues: false,
    };
  }
  const cont = pots.length > 0;
  messages.push(
    cont
      ? msg(
          'good',
          `${pots.map((n) => `Bi ${n}`).join(', ')} vào lỗ — ${me} đánh tiếp`,
        )
      : msg('info', `Không bi nào vào — tới lượt ${them}`),
  );
  return {
    rack: {
      ...base,
      fouls: clearFouls(),
      pushOutAvailable: false,
      turn: cont ? shooter : opp,
    },
    messages,
    foul: null,
    continues: cont,
  };
}
