import { describe, expect, it } from 'vitest';
import { getAllPosts, getPost, getPostSlugs, formatDate } from './blog';

describe('blog', () => {
  it('reads the seed posts, newest first, with reading time', () => {
    const posts = getAllPosts();
    expect(posts.length).toBeGreaterThanOrEqual(4);
    // Sorted descending by date.
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i - 1].date >= posts[i].date).toBe(true);
    }
    expect(posts[0].readingMinutes).toBeGreaterThan(0);
    expect(posts[0].slug).toBeTruthy();
  });

  it('loads a post by slug and returns null for an unknown slug', () => {
    const slug = getPostSlugs()[0];
    const post = getPost(slug);
    expect(post?.slug).toBe(slug);
    expect(post?.content.length).toBeGreaterThan(0);
    expect(getPost('does-not-exist')).toBeNull();
  });

  it('formats dates in UTC', () => {
    expect(formatDate('2026-07-01')).toBe('July 1, 2026');
  });
});
