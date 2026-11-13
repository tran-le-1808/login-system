// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import type { ShotResult } from '../physics/types';
import { resolveEight } from './eightBall';
import { resolveNine } from './nineBall';
import { ensureCue, msg, offTableText, other, respot } from './common';
import { defaultCueSpot, rackFor, withCueAt } from './rack';
import type {
  DecisionChoice,
  GameType,
  MatchConfig,
  PlayerIndex,
  RackState,
  RuleMessage,
  ShotDeclaration,
  ShotVerdict,
} from './types';

/** Ván mới: xếp bi theo luật, bi cái trong tay sau vạch đầu bàn để phá */
export function newRack(
  type: GameType,
  breaker: PlayerIndex,
  seed: number,
): RackState {
  const balls = rackFor(type, seed);
  const cue = defaultCueSpot(balls, true);
  return {
    type,
    balls: withCueAt(balls, cue.x, cue.y),
    turn: breaker,
    breaker,
    isBreak: true,
    ballInHand: 'kitchen',
    restrictToFrontOfHeadString: false,
    openTable: true,
    groups: [null, null],
    fouls: [0, 0],
    pushOutAvailable: false,
    decision: null,
    winner: null,
    winReason: null,
    shotNo: 0,
    seed,
  };
}

/** Trọng tài: chỉ đọc ShotResult + trạng thái ván */
export function resolveShot(
  rack: RackState,
  decl: ShotDeclaration,
  res: ShotResult,
  names: [string, string],
): ShotVerdict {
  const v =
    rack.type === 'eight'
      ? resolveEight(rack, decl, res, names)
      : resolveNine(rack, decl, res, names);
  if (res.miscue)
    v.messages.unshift(
      msg(
        'warn',
        v.foul
          ? 'Trượt cơ (miscue) dẫn tới lỗi'
          : 'Trượt cơ (miscue) — không phạm lỗi',
      ),
    );
  return v;
}

/**
 * Hết giờ (shot clock, WPA): là lỗi — đối thủ được bi trong tay (9 bi: tính vào chuỗi 3 lỗi).
 * Hết giờ ở cú phá: quyền phá chuyển cho đối thủ. Hết giờ khi đang chờ lựa chọn: tự chọn phương án đầu.
 */
export function applyTimeoutFoul(
  rack: RackState,
  names: [string, string],
): { rack: RackState; messages: RuleMessage[] } {
  const me = rack.turn;
  const opp = other(me);
  if (rack.decision) {
    const choice = decisionOptions(rack)[0]?.choice;
    if (!choice) return { rack, messages: [] };
    const out = applyDecision(rack, choice, names);
    return {
      rack: out.rack,
      messages: [
        msg('warn', `⏰ ${names[rack.decision.by]} hết giờ — tự chọn mặc định`),
        ...out.messages,
      ],
    };
  }
  if (rack.isBreak) {
    return {
      rack: { ...rack, turn: opp, breaker: opp, ballInHand: 'kitchen' },
      messages: [
        msg('foul', `⏰ ${names[me]} hết giờ phá bi — ${names[opp]} phá`),
      ],
    };
  }
  const fouls: [number, number] = [...rack.fouls];
  if (rack.type === 'nine') fouls[me] += 1;
  if (rack.type === 'nine' && fouls[me] >= 3) {
    return {
      rack: {
        ...rack,
        fouls,
        winner: opp,
        winReason: 'Đối thủ phạm 3 lỗi liên tiếp (hết giờ)',
      },
      messages: [
        msg('foul', `⏰ ${names[me]} hết giờ — lỗi thứ 3 liên tiếp, thua ván!`),
      ],
    };
  }
  const messages = [
    msg(
      'foul',
      `⏰ Lỗi: ${names[me]} hết giờ — ${names[opp]} được bi trong tay`,
    ),
  ];
  if (rack.type === 'nine' && fouls[me] === 2)
    messages.push(msg('warn', `⚠️ ${names[me]} đang có 2 lỗi liên tiếp`));
  return {
    rack: {
      ...rack,
      fouls,
      turn: opp,
      ballInHand: 'table',
      restrictToFrontOfHeadString: false,
      pushOutAvailable: false,
      shotNo: rack.shotNo + 1,
      balls: ensureCue(rack.balls, false),
    },
    messages,
  };
}

/**
 * Chế độ TẬP LUYỆN (không luật): bi vào lỗ thì bỏ ra khỏi bàn (mục tiêu luyện tập), nhưng bi bị đánh
 * VĂNG KHỎI BÀN phải quay lại: bi cái luôn trở lại để đặt (bi trong tay), bi khác đặt lại trên foot spot.
 */
export function resolvePractice(
  rack: RackState,
  res: ShotResult,
  pocketName: (id: number) => string,
): { rack: RackState; messages: RuleMessage[] } {
  const messages: RuleMessage[] = [];
  const pots = res.pocketed.filter((p) => p.ball !== 0);
  for (const p of pots)
    messages.push(msg('good', `Bi ${p.ball} vào lỗ ${pocketName(p.pocket)}`));
  const cueGone = res.scratch || res.offTable.includes(0);
  let balls = res.final;
  for (const n of res.offTable.filter((x) => x !== 0)) balls = respot(balls, n);
  if (res.offTable.length)
    messages.push(
      msg(
        'foul',
        `${offTableText(res)} — ${cueGone ? 'đặt lại bi cái' : 'bi được đặt lại lên bàn'}`,
      ),
    );
  if (res.scratch) messages.push(msg('foul', 'Bi cái rơi lỗ — đặt lại bi cái'));
  if (res.miscue) messages.push(msg('warn', 'Trượt cơ (miscue)'));
  if (!pots.length && !cueGone && !res.offTable.length)
    messages.push(
      msg(
        'info',
        res.firstHit === null
          ? 'Bi cái không chạm bi nào'
          : `Bi cái chạm bi ${res.firstHit} trước`,
      ),
    );
  if (cueGone) balls = ensureCue(balls, false);
  return {
    rack: {
      ...rack,
      balls,
      isBreak: false,
      ballInHand: cueGone ? 'table' : null,
      shotNo: rack.shotNo + 1,
    },
    messages,
  };
}

/** Các lựa chọn cho tình huống đang chờ */
export function decisionOptions(
  rack: RackState,
): { choice: DecisionChoice; label: string; hint: string }[] {
  switch (rack.decision?.kind) {
    case 'illegalBreak':
      return [
        {
          choice: 'acceptTable',
          label: 'Chấp nhận bàn',
          hint: 'Đánh tiếp từ vị trí hiện tại',
        },
        {
          choice: 'rerackSelfBreak',
          label: 'Xếp lại & tự phá',
          hint: 'Bạn phá ván mới',
        },
        {
          choice: 'rerackOpponentBreak',
          label: 'Bắt đối thủ phá lại',
          hint: 'Xếp lại, người vừa phá phá tiếp',
        },
      ];
    case 'eightOnBreak':
      return [
        {
          choice: 'spotAndContinue',
          label: 'Đặt lại bi 8 & đánh tiếp',
          hint: 'Bàn vẫn mở',
        },
        {
          choice: 'rerack',
          label: 'Xếp lại & phá lại',
          hint: 'Bạn phá lại từ đầu',
        },
      ];
    case 'eightOnBreakScratch':
      return [
        {
          choice: 'spotWithBallInHand',
          label: 'Đặt lại bi 8, bi trong tay',
          hint: 'Đặt bi cái sau vạch đầu bàn',
        },
        {
          choice: 'rerack',
          label: 'Xếp lại & tự phá',
          hint: 'Bạn phá ván mới',
        },
      ];
    case 'pushOutResponse':
      return [
        { choice: 'shoot', label: 'Đánh từ vị trí này', hint: 'Bạn đánh tiếp' },
        {
          choice: 'passBack',
          label: 'Nhường lại',
          hint: 'Người vừa push out phải đánh',
        },
      ];
    default:
      return [];
  }
}

export function applyDecision(
  rack: RackState,
  choice: DecisionChoice,
  names: [string, string],
): { rack: RackState; messages: RuleMessage[] } {
  const d = rack.decision;
  if (!d) return { rack, messages: [] };
  const by = d.by;
  const nextSeed = (rack.seed * 1103515245 + 12345) >>> 0;
  const rerack = (breaker: PlayerIndex, text: string) => ({
    rack: newRack(rack.type, breaker, nextSeed),
    messages: [msg('info', text)],
  });
  const clear = { ...rack, decision: null } as RackState;
  switch (choice) {
    case 'acceptTable':
      return {
        rack: {
          ...clear,
          isBreak: false,
          openTable: true,
          turn: by,
          ballInHand: null,
        },
        messages: [msg('info', `${names[by]} chấp nhận bàn và đánh tiếp`)],
      };
    case 'rerackSelfBreak':
      return rerack(by, `Xếp lại bi — ${names[by]} phá`);
    case 'rerackOpponentBreak':
      return rerack(other(by), `Xếp lại bi — ${names[other(by)]} phá lại`);
    case 'rerack':
      return rerack(by, `Xếp lại bi — ${names[by]} phá`);
    case 'spotAndContinue':
      return {
        rack: {
          ...clear,
          balls: respot(rack.balls, 8),
          isBreak: false,
          openTable: true,
          turn: by,
        },
        messages: [
          msg('info', `Bi 8 được đặt lại — ${names[by]} đánh tiếp, bàn mở`),
        ],
      };
    case 'spotWithBallInHand': {
      const balls = ensureCue(respot(rack.balls, 8), true);
      return {
        rack: {
          ...clear,
          balls,
          isBreak: false,
          openTable: true,
          turn: by,
          ballInHand: 'kitchen',
          restrictToFrontOfHeadString: true,
        },
        messages: [
          msg(
            'info',
            `Bi 8 được đặt lại — ${names[by]} có bi trong tay sau vạch đầu bàn`,
          ),
        ],
      };
    }
    case 'shoot':
      return {
        rack: { ...clear, turn: by },
        messages: [msg('info', `${names[by]} chọn đánh tiếp sau push out`)],
      };
    case 'passBack':
      return {
        rack: { ...clear, turn: other(by) },
        messages: [
          msg(
            'info',
            `${names[by]} nhường lại — ${names[other(by)]} phải đánh`,
          ),
        ],
      };
  }
}

// ======================= TRẬN ĐẤU (race-to-N) =======================

export interface MatchState {
  config: MatchConfig;
  rack: RackState;
  score: [number, number];
  rackNo: number;
  matchWinner: PlayerIndex | null;
}

export function startMatch(
  config: MatchConfig,
  firstBreaker: PlayerIndex = 0,
): MatchState {
  return {
    config,
    rack: newRack(config.type, firstBreaker, config.seed),
    score: [0, 0],
    rackNo: 1,
    matchWinner: null,
  };
}

/** Ghi nhận ván vừa xong; trả về trận đã cập nhật (chưa xếp ván mới) */
export function recordRackWin(m: MatchState, winner: PlayerIndex): MatchState {
  const score: [number, number] = [...m.score];
  score[winner] += 1;
  return {
    ...m,
    score,
    matchWinner: score[winner] >= m.config.raceTo ? winner : null,
  };
}

/** Xếp ván kế tiếp theo luật phá: luân phiên hoặc người thắng phá */
export function nextRack(m: MatchState): MatchState {
  const last = m.rack;
  const breaker =
    m.config.breakRule === 'winner' && last.winner !== null
      ? last.winner
      : other(last.breaker);
  const seed = (m.config.seed + m.rackNo * 7919) >>> 0;
  return {
    ...m,
    rack: newRack(m.config.type, breaker, seed),
    rackNo: m.rackNo + 1,
  };
}

/** Đặt bi cái (bi trong tay) — trả về bàn mới */
export function placeCue(rack: RackState, x: number, y: number): RackState {
  return { ...rack, balls: withCueAt(rack.balls, x, y) };
}

export { ensureCue };
