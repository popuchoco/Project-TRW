import { describe, expect, it } from 'vitest';
import { createStatusController } from '../../src/ui/status';

describe('createStatusController', () => {
  it('keeps a sticky message visible after hide', () => {
    const element = { textContent: '', hidden: true };
    const status = createStatusController(element);

    status.showSticky('A');
    status.hide();

    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe('A');
  });

  it('hides a regular message after hide', () => {
    const element = { textContent: '', hidden: true };
    const status = createStatusController(element);

    status.show('x');
    status.hide();

    expect(element.hidden).toBe(true);
  });

  it('restores the sticky message after hiding a regular message', () => {
    const element = { textContent: '', hidden: true };
    const status = createStatusController(element);

    status.showSticky('A');
    status.show('x');
    status.hide();

    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe('A');
  });
});
