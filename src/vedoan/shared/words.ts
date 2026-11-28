/** Kho từ Vẽ Đoán (tiếng Việt). Độ khó 1 = dễ vẽ, 2 = vừa, 3 = khó. */
export interface WordEntry {
  w: string;
  d: 1 | 2 | 3;
  cat: string;
}

const RAW: Record<string, [string, string, string]> = {
  // chủ đề: [dễ, vừa, khó] — mỗi chuỗi phân tách bằng dấu phẩy
  'Con vật': [
    'con mèo,con chó,con cá,con gà,con vịt,con heo,con bò,con rắn,con ốc sên,con cua,con bướm,con ong,con chim,con thỏ,con rùa,con voi',
    'con hươu cao cổ,con khỉ,con ngựa,con sư tử,con cá mập,con bạch tuộc,con chuột,con ếch,con cú mèo,con muỗi,con nhện,con kiến,con gấu,con chim cánh cụt,con tôm',
    'con tắc kè hoa,con cá heo,con đà điểu,con kangaroo,con công,con dơi,con sứa,con nhím,con lạc đà,con kỳ lân',
  ],
  'Đồ vật': [
    'cái ghế,cái bàn,cái ly,cái chén,đôi đũa,cái muỗng,cái kéo,cây bút,quyển sách,cái đồng hồ,cái chìa khoá,cây dù,cái nón,đôi dép,cái gương,bóng đèn,quả bóng bay,cái diều,con búp bê,cái hộp quà,cái xô',
    'cái quạt,cái tivi,điện thoại,máy tính,cái ba lô,cái kính,cái thang,cái chổi,cái búa,cái ổ khoá,cái gối,cái nồi,bàn chải đánh răng,cái tủ lạnh,máy ảnh',
    'nam châm,cái la bàn,kính lúp,ống nhòm,cái đàn guitar,cái micro,máy giặt,cái nơ,bàn ủi,đồng hồ cát',
  ],
  'Đồ ăn': [
    'quả táo,quả chuối,quả cam,quả dưa hấu,cái bánh,cây kem,quả trứng,củ cà rốt,bắp ngô,quả nho,cây kẹo mút,ổ bánh mì',
    'tô phở,bánh chưng,bánh pizza,ly trà sữa,xúc xích,bánh kem sinh nhật,quả dứa,quả dâu tây,quả xoài,bắp rang bơ,hamburger,bánh xèo',
    'bánh trung thu,chè ba màu,bún chả,nem rán,gỏi cuốn,sầu riêng,cơm tấm,bánh flan,bánh bao,mì xào',
  ],
  'Phương tiện': [
    'xe đạp,ô tô,máy bay,con thuyền,xe buýt,tàu hoả,xe máy',
    'trực thăng,tàu ngầm,xe cứu hỏa,xe cứu thương,khinh khí cầu,xe tải,tên lửa,xích lô',
    'tàu vũ trụ,xe ủi đất,cáp treo,du thuyền,thuyền thúng,xe ba gác',
  ],
  'Thiên nhiên': [
    'mặt trời,mặt trăng,ngôi sao,đám mây,cái cây,bông hoa,ngọn núi,cơn mưa,cầu vồng,ngọn lửa,bông tuyết',
    'núi lửa,thác nước,hòn đảo,cây xương rồng,cây dừa,sấm sét,hoa sen,cái hang,dòng sông,bãi biển',
    'nhật thực,cơn lốc xoáy,sa mạc,rừng rậm,sóng thần,động đất,dải ngân hà,san hô',
  ],
  'Việt Nam': [
    'nón lá,áo dài,cái trống,lồng đèn,phong bao lì xì',
    'hoa mai,cây tre,chợ nổi,múa lân,bánh tét,tò he,đèn ông sao,trâu cày ruộng',
    'chùa Một Cột,vịnh Hạ Long,cầu Rồng,ruộng bậc thang,múa rối nước,Tết Trung thu,cột cờ Hà Nội',
  ],
  'Nghề nghiệp': [
    'bác sĩ,cảnh sát,ca sĩ,giáo viên,đầu bếp',
    'lính cứu hỏa,phi hành gia,nông dân,họa sĩ,thợ cắt tóc,ngư dân,phi công,thợ xây',
    'nhiếp ảnh gia,thám tử,ảo thuật gia,thợ lặn,nhà khoa học,người đưa thư',
  ],
  'Hoạt động': [
    'ngủ,khóc,cười,chạy bộ,bơi lội,nhảy dây,đá bóng,ăn cơm',
    'câu cá,thả diều,leo núi,đánh răng,trượt patin,đọc sách,tắm biển,cắm trại',
    'lướt sóng,nhảy dù,trượt tuyết,chơi cờ vua,đi cà kheo,kéo co,tập yoga,hát karaoke',
  ],
  'Địa điểm': [
    'ngôi nhà,trường học,bệnh viện,công viên',
    'sân bay,bến xe,siêu thị,thư viện,rạp chiếu phim,hồ bơi,sở thú,nhà hàng',
    'ngọn hải đăng,lâu đài,kim tự tháp,khu vui chơi,trạm xăng,phòng thí nghiệm',
  ],
};

export const WORDS: WordEntry[] = Object.entries(RAW).flatMap(([cat, lists]) =>
  lists.flatMap((list, i) =>
    list
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => ({ w, d: (i + 1) as 1 | 2 | 3, cat })),
  ),
);
