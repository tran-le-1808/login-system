/**
 * Chuẩn hoá tiếng Việt để tìm kiếm không phân biệt dấu / hoa thường:
 * "Nguyễn" -> "nguyen", "Đặng" -> "dang". Dùng CHUNG cho lúc lập chỉ mục (searchText)
 * và lúc tìm, để hai phía luôn khớp nhau.
 */
export const normalizeVi = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
