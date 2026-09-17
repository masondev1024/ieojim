import { describe, expect, it } from 'vitest';
import { readStartContext } from '../../src/client/workspace/workspace-start-context';

describe('workspace entry context', () => {
  it('defaults an ordinary visit to a generic, non-example workspace', () => {
    expect(readStartContext('')).toEqual({ template: 'custom', example: null, hasSelection: false });
  });

  it.each(['custom', 'travel', 'coordination'])('recognizes the explicit %s template', (template) => {
    expect(readStartContext(`?template=${template}`)).toEqual({ template, example: null, hasSelection: true });
  });

  it.each([['coordination', 'coordination'], ['syllabus', 'custom'], ['departure', 'travel'], ['travel', 'travel']])('keeps %s sample context without creating it', (example, template) => {
    expect(readStartContext(`?example=${example}`)).toEqual({ template, example, hasSelection: true });
  });

  it('prefers the explicitly selected real template independently of the sample', () => {
    expect(readStartContext('?template=custom&example=coordination')).toEqual({ template: 'custom', example: 'coordination', hasSelection: true });
  });

  it.each(['?template=unknown', '?example=unknown', '?template=&example=', '?template=%3Cscript%3E&example=%3Cscript%3E'])('falls back safely for %s', (query) => {
    expect(readStartContext(query)).toEqual({ template: 'custom', example: null, hasSelection: true });
  });
});
