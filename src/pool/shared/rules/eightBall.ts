// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import { POOL_TABLE } from '../physics/table';
import type { ShotResult } from '../physics/types';
import {
  GROUP_LABEL,
  offTableText,
  ensureCue,
  groupCleared,
  groupOf,
  msg,
  other,
  potted,
} from './common';
import type {
  RackState,
  RuleMessage,
  ShotDeclaration,
  ShotVerdict,
} from './types';

/**
 * TRỌNG TÀI 8 BI (WPA) — hàm thuần: (trạng thái ván, khai báo, nhật ký cú đánh) -> trạng thái mới.
 * `rack.balls` là vị trí ĐẦU cú đánh, `res.final` là vị trí sau cú đánh.
 */
export function resolveEight(
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
  const eightIn = pots.includes(8);
  // Bi 8 văng khỏi bàn (jump shot): lúc phá -> như bi 8 vào lỗ (chọn đặt lại); sau đó -> thua ván
  const eightOff = res.offTable.includes(8);
  const cueGone = res.scratch || res.offTable.includes(0);
  const messages: RuleMessage[] = [];
  const base: RackState = {
    ...rack,
    balls: res.final,
    shotNo: rack.shotNo + 1,
    ballInHand: null,
    restrictToFrontOfHeadString: false,
  };

  // ================= CÚ PHÁ =================
  if (rack.isBreak) {
    const legalBreak = pots.length > 0 || res.objectBallsToCushion.length >= 4;
    if ((eightIn || eightOff) && cueGone) {
      messages.push(
        msg(
          'foul',
          `Bi 8 ${eightIn ? 'vào lỗ' : 'văng khỏi bàn'} kèm bi cái ${res.scratch ? 'rơi lỗ' : 'văng khỏi bàn'} khi phá — ${them} được chọn`,
        ),
      );
      return {
        rack: { ...base, decision: { kind: 'eightOnBreakScratch', by: opp } },
        messages,
        foul: 'Bi cái rơi lỗ khi phá',
        continues: false,
      };
    }
    if (eightIn || eightOff) {
      messages.push(
        msg(
          'info',
          `Bi 8 ${eightIn ? 'vào lỗ' : 'văng khỏi bàn'} khi phá — ${me} chọn đặt lại bi 8 hoặc xếp lại`,
        ),
      );
      return {
        rack: { ...base, decision: { kind: 'eightOnBreak', by: shooter } },
        messages,
        foul: null,
        continues: true,
      };
    }
    if (res.scratch || res.offTable.length) {
      const foul = res.scratch
        ? 'Bi cái rơi lỗ khi phá'
        : `${offTableText(res)} khi phá`;
      messages.push(
        msg(
          'foul',
          `Lỗi: ${foul} — ${them} được bi trong tay sau vạch đầu bàn`,
        ),
      );
      return {
        rack: {
          ...base,
          balls: ensureCue(res.final, true),
          turn: opp,
          isBreak: false,
          openTable: true,
          ballInHand: 'kitchen',
          restrictToFrontOfHeadString: true,
        },
        messages,
        foul,
        continues: false,
      };
    }
    if (!legalBreak) {
      messages.push(
        msg(
          'warn',
          `Phá không hợp lệ (không bi nào vào, chỉ ${res.objectBallsToCushion.length} bi chạm băng) — ${them} được chọn`,
        ),
      );
      return {
        rack: { ...base, decision: { kind: 'illegalBreak', by: opp } },
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
            `Phá đẹp! ${pots.length} bi vào lỗ — bàn vẫn mở, ${me} đánh tiếp`,
          )
        : msg('info', `Phá hợp lệ — bàn mở, tới lượt ${them}`),
    );
    return {
      rack: {
        ...base,
        isBreak: false,
        openTable: true,
        turn: cont ? shooter : opp,
      },
      messages,
      foul: null,
      continues: cont,
    };
  }

  // ================= CÚ ĐÁNH THƯỜNG =================
  const cleared = groupCleared(rack, shooter);
  const myGroup = rack.groups[shooter];
  let foul: string | null = null;
  const fh = res.firstHit;
  if (res.scratch) foul = 'Bi cái rơi lỗ';
  else if (res.offTable.length) foul = offTableText(res);
  else if (fh === null) foul = 'Bi cái không chạm bi nào';
  else if (rack.openTable && fh === 8)
    foul = 'Chạm bi 8 trước khi bàn đã chia nhóm';
  else if (!rack.openTable && cleared && fh !== 8)
    foul = `Phải chạm bi 8 trước (đã sạch nhóm) nhưng chạm bi ${fh}`;
  else if (!rack.openTable && !cleared && groupOf(fh) !== myGroup)
    foul = `Chạm sai bi đầu tiên (bi ${fh}, không thuộc ${GROUP_LABEL[myGroup!]})`;
  else if (rack.restrictToFrontOfHeadString) {
    const start = rack.balls.find((b) => b.n === fh);
    if (start && start.x <= POOL_TABLE.headStringX)
      foul = `Bi ${fh} nằm sau vạch đầu bàn — không được nhắm khi có bi trong tay sau vạch`;
  }
  if (!foul && pots.length === 0 && res.cushionAfterContact.length === 0)
    foul = 'Không có bi nào chạm băng sau va chạm';

  // ---- Bi 8 văng khỏi bàn: thua ngay (WPA) ----
  if (eightOff && !eightIn) {
    const lose = 'Làm bi 8 văng khỏi bàn';
    messages.push(msg('foul', `${me} thua ván: ${lose}`));
    return {
      rack: { ...base, winner: opp, winReason: lose },
      messages,
      foul: lose,
      continues: false,
    };
  }

  // ---- Bi 8 vào lỗ: thắng hoặc thua ngay ----
  if (eightIn) {
    const pocket8 = res.pocketed.find((p) => p.ball === 8)!.pocket;
    const name8 = POOL_TABLE.pockets[pocket8].name.toLowerCase();
    let lose: string | null = null;
    if (foul) lose = `Đưa bi 8 vào lỗ khi phạm lỗi (${foul.toLowerCase()})`;
    else if (rack.openTable || !cleared)
      lose = 'Đưa bi 8 vào lỗ khi chưa sạch nhóm';
    else if (decl.safety || !decl.call || decl.call.ball !== 8)
      lose = 'Đưa bi 8 vào lỗ khi không gọi bi 8';
    else if (decl.call.pocket !== pocket8)
      lose = `Bi 8 vào lỗ ${name8} — không phải lỗ đã gọi`;
    if (lose) {
      messages.push(msg('foul', `${me} thua ván: ${lose}`));
      return {
        rack: { ...base, winner: opp, winReason: lose },
        messages,
        foul: foul ?? lose,
        continues: false,
      };
    }
    messages.push(msg('win', `${me} đưa bi 8 vào lỗ ${name8} — thắng ván!`));
    return {
      rack: {
        ...base,
        winner: shooter,
        winReason: 'Đưa bi 8 vào đúng lỗ đã gọi',
      },
      messages,
      foul: null,
      continues: false,
    };
  }

  if (foul) {
    messages.push(msg('foul', `Lỗi: ${foul} — ${them} được bi trong tay`));
    return {
      rack: {
        ...base,
        balls: ensureCue(res.final, false),
        turn: opp,
        ballInHand: 'table',
      },
      messages,
      foul,
      continues: false,
    };
  }

  // ---- Không lỗi: xét bi gọi ----
  const call = decl.safety ? null : (decl.call ?? null);
  const calledMade =
    !!call &&
    call.ball !== 8 &&
    res.pocketed.some(
      (p) => p.ball === call.ball && p.pocket === call.pocket,
    ) &&
    (rack.openTable || groupOf(call.ball) === myGroup);

  let groups = rack.groups;
  let openTable = rack.openTable;
  if (calledMade && rack.openTable) {
    const g = groupOf(call!.ball)!;
    groups =
      shooter === 0
        ? [g, g === 'solids' ? 'stripes' : 'solids']
        : [g === 'solids' ? 'stripes' : 'solids', g];
    openTable = false;
    messages.push(msg('good', `${me} chọn nhóm ${GROUP_LABEL[g]}`));
  }

  if (decl.safety) {
    messages.push(msg('info', `${me} đánh phòng thủ — tới lượt ${them}`));
  } else if (calledMade) {
    messages.push(
      msg(
        'good',
        `Bi ${call!.ball} vào lỗ ${POOL_TABLE.pockets[call!.pocket].name.toLowerCase()} — ${me} đánh tiếp`,
      ),
    );
  } else if (pots.length) {
    messages.push(msg('info', `Bi gọi không vào đúng lỗ — tới lượt ${them}`));
  } else {
    messages.push(msg('info', `Không bi nào vào — tới lượt ${them}`));
  }

  return {
    rack: { ...base, groups, openTable, turn: calledMade ? shooter : opp },
    messages,
    foul: null,
    continues: calledMade,
  };
}
