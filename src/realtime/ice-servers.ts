/**
 * Cấu hình ICE cho WebRTC (voice chat), đọc từ biến môi trường của server:
 *   STUN_URLS        (tuỳ chọn, phân tách bằng dấu phẩy; mặc định STUN công khai của Google)
 *   TURN_URLS        (tuỳ chọn, vd. "turn:turn.example.com:3478,turns:turn.example.com:5349")
 *   TURN_USERNAME    / TURN_CREDENTIAL
 * Không đặt TURN credential ở frontend.
 */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

const split = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function getIceServers(): IceServerConfig[] {
  const stun = split(process.env.STUN_URLS);
  const servers: IceServerConfig[] = [
    {
      urls: stun.length
        ? stun
        : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    },
  ];
  const turn = split(process.env.TURN_URLS);
  if (turn.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: turn,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}
