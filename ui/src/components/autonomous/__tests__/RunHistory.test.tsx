// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for RunHistory — IMP-13 deep-link surface.
 *
 * Covers:
 *  - Run rows that carry ``conversation_id`` render an "Open in chat"
 *    deep-link to ``/chat/<id>`` when expanded.
 *  - Rows without ``conversation_id`` (chat publishing disabled, or
 *    runs that pre-date IMP-13) do NOT render the link, so the row
 *    stays tidy in those modes.
 *  - The link uses the run's actual ``conversation_id`` -- a regression
 *    on the URL shape would silently 404 from /chat/[uuid].
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// next/link is a server-aware component; Jest renders it fine but we
// mock it to a plain anchor so we can read the href off the DOM
// without pulling in the Next.js runtime.
jest.mock('next/link', () => {
  // eslint-disable-next-line react/display-name
  return ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
});

// Lucide icons render as SVGs that don't matter for these assertions;
// stub them to bare spans to keep the test output readable and avoid
// any Jest/Next ESM friction with the real package.
jest.mock('lucide-react', () => ({
  RefreshCw: (props: Record<string, unknown>) => <span data-testid="icon-refresh" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <span data-testid="icon-down" {...props} />,
  ChevronRight: (props: Record<string, unknown>) => <span data-testid="icon-right" {...props} />,
  MessageSquare: (props: Record<string, unknown>) => <span data-testid="icon-chat" {...props} />,
  Send: () => <span />,
}));

jest.mock('@/components/shared/timeline/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

// The component fetches via `autonomousApi.listRuns`; we stub the
// whole module so each test can hand-tailor the returned runs.
const mockListRuns = jest.fn();
const mockFollowUpRun = jest.fn();
jest.mock('../api', () => ({
  autonomousApi: {
    listRuns: (...args: unknown[]) => mockListRuns(...args),
    followUpRun: (...args: unknown[]) => mockFollowUpRun(...args),
  },
  AutonomousApiError: class extends Error {
    status = 0;
    detail: unknown = null;
  },
}));

import { RunHistory } from '../RunHistory';
import type { TaskRun } from '../types';

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    run_id: 'r-1',
    task_id: 't-1',
    task_name: 'Daily PR sweep',
    status: 'success',
    started_at: '2026-04-19T10:00:00Z',
    finished_at: '2026-04-19T10:00:05Z',
    response_preview: 'all good',
    error: null,
    conversation_id: '11111111-1111-1111-1111-111111111111',
    execution_context_id: 'isolated-run-context',
    ...overrides,
  };
}

beforeEach(() => {
  mockListRuns.mockReset();
  mockFollowUpRun.mockReset();
});

afterEach(() => {
  // The component installs a 5s polling interval; flush any pending
  // timers so they don't leak between tests.
  jest.useRealTimers();
});

describe('RunHistory deep-link to chat', () => {
  it('renders Open-in-chat link for runs with conversation_id when expanded', async () => {
    const run = makeRun();
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" />);

    // Wait for the row to land in the DOM.
    const row = await screen.findByText(run.run_id);
    fireEvent.click(row);

    const link = await screen.findByTestId('run-chat-link');
    expect(link).toHaveAttribute('href', `/chat/${run.conversation_id}`);
    // Accessible label used by screen readers identifies which run
    // the deep-link belongs to -- guard against regressions that
    // silently strip the aria-label.
    expect(link).toHaveAttribute(
      'aria-label',
      `Open run ${run.run_id} in chat`,
    );
  });

  it('hides Open-in-chat link when conversation_id is null (chat publishing disabled)', async () => {
    // Pre-IMP-13 / chat-publishing-off shape: the field is absent.
    const run = makeRun({ conversation_id: null });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" />);

    const row = await screen.findByText(run.run_id);
    fireEvent.click(row);

    // Expanded panel rendered (response preview is visible) ...
    await screen.findByText(/all good/);
    // ... but the deep-link is intentionally absent.
    expect(screen.queryByTestId('run-chat-link')).toBeNull();
  });

  it('uses the per-run conversation_id (not a shared/static URL)', async () => {
    const runA = makeRun({
      run_id: 'r-A',
      conversation_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const runB = makeRun({
      run_id: 'r-B',
      conversation_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    mockListRuns.mockResolvedValue([runA, runB]);

    render(<RunHistory taskId="t-1" />);

    fireEvent.click(await screen.findByText('r-A'));
    fireEvent.click(await screen.findByText('r-B'));

    await waitFor(() => {
      expect(screen.getAllByTestId('run-chat-link')).toHaveLength(2);
    });
    const links = screen.getAllByTestId('run-chat-link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain(`/chat/${runA.conversation_id}`);
    expect(hrefs).toContain(`/chat/${runB.conversation_id}`);
  });
});

describe('RunHistory webhook results', () => {
  it('renders the complete webhook response as markdown instead of the preview', async () => {
    const run = makeRun({
      conversation_id: null,
      response_preview: 'Short **preview**',
      response_full: '# Full result\n\n- first\n- second',
    });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" triggerType="webhook" />);
    fireEvent.click(await screen.findByText(run.run_id));

    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.queryByText('Response preview')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('webhook-run-result').querySelector('[data-testid="markdown-renderer"]'),
    ).toHaveTextContent(
      '# Full result - first - second',
    );
    expect(screen.queryByText('Short **preview**')).not.toBeInTheDocument();
  });

  it('falls back to the preview for webhook runs created before response_full existed', async () => {
    const run = makeRun({
      conversation_id: null,
      response_preview: '**Legacy result**',
      response_full: null,
    });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" triggerType="webhook" />);
    fireEvent.click(await screen.findByText(run.run_id));

    expect(
      screen.getByTestId('webhook-run-result').querySelector('[data-testid="markdown-renderer"]'),
    ).toHaveTextContent('**Legacy result**');
  });

  it('keeps the compact preview for non-webhook runs', async () => {
    const run = makeRun({
      response_preview: 'Compact preview',
      response_full: '# Full scheduled result',
    });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" triggerType="cron" />);
    fireEvent.click(await screen.findByText(run.run_id));

    expect(screen.getByText('Response preview')).toBeInTheDocument();
    expect(screen.getByText('Compact preview')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
  });
});

describe('RunHistory selected-run follow-up', () => {
  it.each(['cron', 'interval', 'webhook'] as const)(
    'continues the explicitly selected %s run',
    async (triggerType) => {
      const run = makeRun({ run_id: `${triggerType}-run` });
      const latest = makeRun({ run_id: 'latest-run', started_at: '2026-04-20T10:00:00Z' });
      mockListRuns.mockResolvedValue([run, latest]);
      mockFollowUpRun.mockResolvedValue({
        status: 'accepted',
        task_id: 't-1',
        run_id: 'follow-up-run',
        parent_run_id: run.run_id,
      });

      render(
        <RunHistory taskId="t-1" triggerType={triggerType} allowFollowUp />,
      );
      fireEvent.click(await screen.findByText(run.run_id));
      fireEvent.click(screen.getByText(latest.run_id));
      expect(screen.getAllByRole('button', { name: 'Continue this run' })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Continue this run' }));
      fireEvent.change(screen.getByPlaceholderText(/using only this run's context/i), {
        target: { value: 'Investigate this exact result' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));

      await waitFor(() => {
        expect(mockFollowUpRun).toHaveBeenCalledWith(
          't-1',
          run.run_id,
          'Investigate this exact result',
        );
      });
    },
  );

  it('does not offer exact continuation for legacy runs without a context id', async () => {
    const run = makeRun({ execution_context_id: null });
    mockListRuns.mockResolvedValue([run]);

    render(<RunHistory taskId="t-1" triggerType="cron" allowFollowUp />);
    fireEvent.click(await screen.findByText(run.run_id));

    expect(screen.queryByRole('button', { name: 'Continue this run' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  });
});

describe('RunHistory latest-run composer', () => {
  it.each(['cron', 'interval', 'webhook'] as const)(
    'replies directly to the latest %s run without a continuation button',
    async (triggerType) => {
      const run = makeRun();
      mockListRuns.mockResolvedValue([run]);
      mockFollowUpRun.mockResolvedValue({ run_id: 'reply-1' });
      render(<RunHistory taskId="t-1" triggerType={triggerType} allowFollowUp />);

      fireEvent.click(await screen.findByText(run.run_id));
      expect(screen.queryByRole('button', { name: 'Continue this run' })).toBeNull();
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Explain the result' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      await waitFor(() => expect(mockFollowUpRun).toHaveBeenCalledWith('t-1', run.run_id, 'Explain the result'));
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''));
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    },
  );

  it('continues the newest follow-up even when thread ordering puts its parent first', async () => {
    const root = makeRun();
    const reply = makeRun({ run_id: 'reply-1', parent_run_id: root.run_id, started_at: '2026-04-20T10:00:00Z' });
    mockListRuns.mockResolvedValue([root, reply]);
    mockFollowUpRun.mockResolvedValue({ run_id: 'reply-2' });
    render(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp />);
    await screen.findByText(reply.run_id);

    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'And then?' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(mockFollowUpRun).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mockFollowUpRun).toHaveBeenCalledWith('t-1', reply.run_id, 'And then?'));
  });

  it('does not fall back to an older context while the newest run is still running', async () => {
    mockListRuns.mockResolvedValue([
      makeRun(),
      makeRun({ run_id: 'active', started_at: '2026-04-20T10:00:00Z', status: 'running' }),
    ]);
    render(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp />);
    await screen.findByText('active');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  });

  it('allows the next reply after the queued response completes and follows new runs when empty', async () => {
    const run = makeRun();
    const reply = makeRun({ run_id: 'reply', parent_run_id: run.run_id, started_at: '2026-04-20T10:00:00Z' });
    mockListRuns.mockResolvedValue([run]);
    mockFollowUpRun.mockResolvedValue({ run_id: reply.run_id });
    const { rerender } = render(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp />);
    await screen.findByText(run.run_id);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();

    mockListRuns.mockResolvedValue([run, reply]);
    rerender(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp refreshKey={1} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled());

    const newer = makeRun({ run_id: 'newer', started_at: '2026-04-21T10:00:00Z' });
    mockListRuns.mockResolvedValue([run, reply, newer]);
    rerender(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp refreshKey={2} />);
    await screen.findByText(newer.run_id);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Latest reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mockFollowUpRun).toHaveBeenLastCalledWith('t-1', newer.run_id, 'Latest reply'));
  });

  it('retains the message when sending fails so it can be retried', async () => {
    mockListRuns.mockResolvedValue([makeRun()]);
    mockFollowUpRun.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ run_id: 'reply' });
    render(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp />);
    await screen.findByText('r-1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Retry me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Retry me');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mockFollowUpRun).toHaveBeenCalledTimes(2));
  });

  it('keeps a draft on its original run when polling discovers a newer execution', async () => {
    mockListRuns.mockResolvedValue([makeRun()]);
    mockFollowUpRun.mockResolvedValue({ run_id: 'reply' });
    const { rerender } = render(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp />);
    await screen.findByText('r-1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'About this result' } });
    mockListRuns.mockResolvedValue([makeRun(), makeRun({ run_id: 'newer', started_at: '2026-04-20T10:00:00Z' })]);
    rerender(<RunHistory taskId="t-1" triggerType="webhook" allowFollowUp refreshKey={1} />);
    await screen.findByText('newer');
    expect(screen.getByText('Replying to run r-1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mockFollowUpRun).toHaveBeenCalledWith('t-1', 'r-1', 'About this result'));
  });
});
