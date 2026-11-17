/// <reference types="jest" />
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';

describe('Ảnh giải đấu (Cloudinary)', () => {
  const old = process.env.CLOUDINARY_CLOUD_NAME;
  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
  });
  afterAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = old;
  });
  it('chỉ nhận URL ảnh trong thư mục giải đấu trên Cloudinary của hệ thống', () => {
    const ok =
      'https://res.cloudinary.com/demo-cloud/image/upload/v1712345678/chat-zone/billiard/tournaments/abc_123.jpg';
    expect(CloudinaryService.isTournamentThumbnailUrl(ok)).toBe(true);
    for (const bad of [
      'https://evil.example.com/a.jpg',
      'http://res.cloudinary.com/demo-cloud/image/upload/chat-zone/billiard/tournaments/a.jpg',
      'https://res.cloudinary.com/other-cloud/image/upload/chat-zone/billiard/tournaments/a.jpg',
      'https://res.cloudinary.com/demo-cloud/image/upload/avatars/a.jpg',
      'https://res.cloudinary.com/demo-cloud/image/upload/chat-zone/billiard/tournaments/a.jpg?x=<script>',
    ])
      expect(CloudinaryService.isTournamentThumbnailUrl(bad)).toBe(false);
  });
});
