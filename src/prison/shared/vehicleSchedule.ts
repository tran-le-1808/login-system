// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Lịch xe ra vào trại (data/vehicles.json) — hàm thuần, client dùng lại để dự đoán cổng mở. */
import vehiclesJson from './data/vehicles.json';

export interface VehicleDef {
  id: string;
  name: string;
  /** phút trong ngày */
  boardFrom: number;
  depart: number;
  inspectChance: number;
  disguiseFactor: number;
  boardSeconds: number;
  opensGate: boolean;
}

const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

export const VEHICLES: Record<string, VehicleDef> = Object.fromEntries(
  Object.entries(vehiclesJson)
    .filter(([k]) => !k.startsWith('_'))
    .map(([id, v]) => {
      const d = v as {
        name: string;
        boardFrom: string;
        depart: string;
        inspectChance: number;
        disguiseFactor: number;
        boardSeconds: number;
        opensGate?: boolean;
      };
      return [
        id,
        {
          id,
          name: d.name,
          boardFrom: hhmm(d.boardFrom),
          depart: hhmm(d.depart),
          inspectChance: d.inspectChance,
          disguiseFactor: d.disguiseFactor,
          boardSeconds: d.boardSeconds,
          opensGate: !!d.opensGate,
        },
      ];
    }),
);

/** Xe đang đỗ / lên được lúc này */
export function vehiclePresent(id: string, minuteOfDay: number): boolean {
  const v = VEHICLES[id];
  if (!v) return false;
  return v.boardFrom <= v.depart
    ? minuteOfDay >= v.boardFrom && minuteOfDay < v.depart
    : minuteOfDay >= v.boardFrom || minuteOfDay < v.depart;
}

/** Cổng xe tải đang mở vì có xe hàng */
export function gateOpenByVehicle(minuteOfDay: number): boolean {
  return Object.values(VEHICLES).some(
    (v) => v.opensGate && vehiclePresent(v.id, minuteOfDay),
  );
}
