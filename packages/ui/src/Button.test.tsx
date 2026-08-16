/**
 * Tests for @framepilot/ui Button (passing, jsdom + testing-library).
 * See plan/PLAN.md Phase 3.2.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button.js';

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>Apply patch</Button>);
    expect(screen.getByRole('button', { name: 'Apply patch' })).toBeDefined();
  });

  it('defaults to the primary variant', () => {
    render(<Button>OK</Button>);
    expect(screen.getByRole('button').getAttribute('data-variant')).toBe('primary');
  });

  it('exposes variant and size as data attributes', () => {
    render(
      <Button variant="danger" size="sm">
        Delete
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button.getAttribute('data-variant')).toBe('danger');
    expect(button.getAttribute('data-size')).toBe('sm');
  });

  it('loading disables the button and marks it busy', () => {
    render(<Button loading>Run</Button>);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('data-loading')).toBe('true');
    // Label stays in the accessible name so width is preserved.
    expect(screen.getByRole('button', { name: 'Run' })).toBeDefined();
  });

  it('loading remains authoritative when disabled is explicitly false', () => {
    render(
      <Button loading disabled={false}>
        Render
      </Button>,
    );
    expect((screen.getByRole('button', { name: 'Render' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
