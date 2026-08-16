/**
 * Tests for the history + search drawer (Phase 11 M7): grouped list, instant search,
 * row actions (open/rename/duplicate/delete/pin), and the empty/no-match states.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createConversation, type Conversation } from '../../ai/conversation.js';
import type { UseConversations } from '../../ai/useConversations.js';
import { HistoryDrawer } from './HistoryDrawer.js';

const now = Date.now();
const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  ...createConversation({ id, projectId: 'project-1', model: 'mock', now }),
  title: id,
  updatedAt: now,
  ...over,
});

function fakeConversations(list: Conversation[]): UseConversations {
  return {
    conversations: list,
    // Searching pulls in the logs the sidebar keeps evicted; the double resolves
    // immediately because these fixtures are already whole.
    loadAll: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(),
    rename: vi.fn(),
    duplicate: vi.fn(),
    togglePinned: vi.fn(),
    toggleFavorite: vi.fn(),
    remove: vi.fn(),
  } as unknown as UseConversations;
}

describe('HistoryDrawer', () => {
  it('lists conversations grouped by date and opens one on click', () => {
    const conversations = fakeConversations([conv('Alpha'), conv('Beta')]);
    const onClose = vi.fn();
    render(<HistoryDrawer conversations={conversations} onClose={onClose} />);
    expect(screen.getByText('Today')).toBeTruthy();
    fireEvent.click(screen.getByText('Alpha'));
    expect(conversations.open).toHaveBeenCalledWith('Alpha');
    expect(onClose).toHaveBeenCalled();
  });

  it('filters by global search and shows a no-match state', () => {
    const a = { ...conv('Alpha'), title: 'Add captions' };
    const b = { ...conv('Beta'), title: 'Remove silence' };
    render(<HistoryDrawer conversations={fakeConversations([a, b])} onClose={vi.fn()} />);
    const search = screen.getByLabelText('Search conversations');
    fireEvent.change(search, { target: { value: 'captions' } });
    expect(screen.getByText('Add captions', { selector: '.ai-hist-title' })).toBeTruthy();
    expect(screen.queryByText('Remove silence', { selector: '.ai-hist-title' })).toBeNull();
    fireEvent.change(search, { target: { value: 'nothing-here' } });
    expect(screen.getByText(/No matches/)).toBeTruthy();
  });

  it('row actions duplicate, pin, and delete a conversation', () => {
    const conversations = fakeConversations([conv('Alpha')]);
    render(<HistoryDrawer conversations={conversations} onClose={vi.fn()} />);
    const row = screen.getByText('Alpha').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByLabelText('Row actions'));
    fireEvent.click(within(row).getByText('Duplicate'));
    fireEvent.click(within(row).getByLabelText('Row actions'));
    fireEvent.click(within(row).getByText('Pin'));
    fireEvent.click(within(row).getByLabelText('Row actions'));
    fireEvent.click(within(row).getByText('Delete'));
    expect(conversations.duplicate).toHaveBeenCalledWith('Alpha');
    expect(conversations.togglePinned).toHaveBeenCalledWith('Alpha');
    expect(conversations.remove).toHaveBeenCalledWith('Alpha');
  });

  it('renames a conversation inline on Enter', () => {
    const conversations = fakeConversations([conv('Alpha')]);
    render(<HistoryDrawer conversations={conversations} onClose={vi.fn()} />);
    const row = screen.getByText('Alpha').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByLabelText('Row actions'));
    fireEvent.click(within(row).getByText('Rename'));
    const input = screen.getByLabelText('Rename conversation');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(conversations.rename).toHaveBeenCalledWith('Alpha', 'Renamed');
  });

  it('closes on Escape', () => {
    const conversations = fakeConversations([conv('Alpha')]);
    const onClose = vi.fn();
    render(<HistoryDrawer conversations={conversations} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an empty state with no conversations', () => {
    render(<HistoryDrawer conversations={fakeConversations([])} onClose={vi.fn()} />);
    expect(screen.getByText(/No conversations yet/)).toBeTruthy();
  });
});
