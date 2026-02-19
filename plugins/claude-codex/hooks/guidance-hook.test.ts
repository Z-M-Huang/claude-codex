import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// Set env before importing module (TASK_DIR is resolved at load time)
const TEST_PROJECT_DIR = join(import.meta.dir, '.test-project-guidance');
const TEST_TASK_DIR = join(TEST_PROJECT_DIR, '.task');
process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;

// Import after env is set
import {
  discoverAnalysisFiles,
  determinePhase,
} from './guidance-hook.ts';

import type { PipelineProgress } from '../scripts/pipeline-utils.ts';

describe('guidance-hook', () => {
  beforeEach(() => {
    mkdirSync(TEST_TASK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  describe('discoverAnalysisFiles', () => {
    test('returns empty array when no analysis files exist', () => {
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toEqual([]);
    });

    test('discovers a single analysis file', () => {
      writeFileSync(
        join(TEST_TASK_DIR, 'analysis-technical.json'),
        JSON.stringify({ specialist: 'technical', summary: 'test' })
      );
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('technical');
      expect(result[0].file).toBe('analysis-technical.json');
      expect((result[0].data as Record<string, unknown>).specialist).toBe('technical');
    });

    test('discovers multiple analysis files', () => {
      const specialists = ['technical', 'ux-domain', 'security', 'performance', 'architecture'];
      for (const s of specialists) {
        writeFileSync(
          join(TEST_TASK_DIR, `analysis-${s}.json`),
          JSON.stringify({ specialist: s, summary: `${s} findings` })
        );
      }
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toHaveLength(5);
      const names = result.map(r => r.name).sort();
      expect(names).toEqual(['architecture', 'performance', 'security', 'technical', 'ux-domain']);
    });

    test('ignores non-analysis JSON files', () => {
      writeFileSync(
        join(TEST_TASK_DIR, 'pipeline-tasks.json'),
        JSON.stringify({ requirements: 'T1' })
      );
      writeFileSync(
        join(TEST_TASK_DIR, 'user-story.json'),
        JSON.stringify({ title: 'test' })
      );
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toEqual([]);
    });

    test('skips analysis files with invalid JSON', () => {
      writeFileSync(
        join(TEST_TASK_DIR, 'analysis-technical.json'),
        JSON.stringify({ specialist: 'technical' })
      );
      writeFileSync(
        join(TEST_TASK_DIR, 'analysis-broken.json'),
        'not valid json{'
      );
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('technical');
    });

    test('returns empty array when .task directory does not exist', () => {
      rmSync(TEST_TASK_DIR, { recursive: true, force: true });
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toEqual([]);
    });
  });

  describe('determinePhase', () => {
    test('returns requirements_gathering when no pipeline tasks exist', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: null,
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_gathering');
    });

    test('returns requirements_team_pending when pipeline tasks exist but no analyses', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { requirements: 'T1' },
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_team_pending');
      expect(result.message).toContain('pipeline team');
    });

    test('returns requirements_team_exploring when analysis files exist', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { requirements: 'T1' },
        analysisFiles: [
          { name: 'technical', file: 'analysis-technical.json', data: {} },
        ],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_team_exploring');
      expect(result.message).toContain('Do NOT start synthesis yet');
      expect(result.message).toContain('Technical');
    });

    test('does not return synthesizing phase even with multiple analyses', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { requirements: 'T1' },
        analysisFiles: [
          { name: 'technical', file: 'analysis-technical.json', data: {} },
          { name: 'ux-domain', file: 'analysis-ux-domain.json', data: {} },
          { name: 'security', file: 'analysis-security.json', data: {} },
          { name: 'performance', file: 'analysis-performance.json', data: {} },
          { name: 'architecture', file: 'analysis-architecture.json', data: {} },
        ],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      // Should still be exploring, never synthesizing
      expect(result.phase).toBe('requirements_team_exploring');
      expect(result.phase).not.toContain('synthesizing');
      expect(result.message).toContain('5');
    });

    test('returns plan_drafting when user story exists but no plan', () => {
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: null,
        pipelineTasks: { requirements: 'T1' },
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('plan_drafting');
    });

    test('fallback message mentions team fallback', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: null,
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.message).toContain('requirements-gatherer');
    });

    test('pending phase message mentions fallback for team failure', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { requirements: 'T1' },
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.message).toContain('spawning fails');
    });

    // ─── Bug-Fix Pipeline Phase Transitions ───────────────────────────

    test('bug-fix: returns root_cause_analysis (pending) at startup before any RCA files', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { pipeline_type: 'bug-fix', team_name: 'test' },
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('root_cause_analysis');
      expect(result.message).toContain('pending');
    });

    test('bug-fix: returns root_cause_analysis (in progress) when one RCA done', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { pipeline_type: 'bug-fix', team_name: 'test' },
        analysisFiles: [],
        rcaSonnet: { root_cause: { summary: 'test' } },
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('root_cause_analysis');
      expect(result.message).toContain('Sonnet: done');
      expect(result.message).toContain('Opus: running');
    });

    test('bug-fix: returns root_cause_analysis (consolidation) when both RCAs done', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { pipeline_type: 'bug-fix', team_name: 'test' },
        analysisFiles: [],
        rcaSonnet: { root_cause: { summary: 'test' } },
        rcaOpus: { root_cause: { summary: 'test' } },
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('root_cause_analysis');
      expect(result.message).toContain('Consolidation');
    });

    test('bug-fix: skips Sonnet/Opus plan reviews, goes to Codex validation', () => {
      const progress: PipelineProgress = {
        userStory: { title: 'Fix: test bug' },
        plan: { steps: [] },
        pipelineTasks: { pipeline_type: 'bug-fix', team_name: 'test' },
        analysisFiles: [],
        rcaSonnet: { root_cause: { summary: 'test' } },
        rcaOpus: { root_cause: { summary: 'test' } },
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      // Must NOT be plan_review_sonnet — bug-fix skips to Codex
      expect(result.phase).toBe('plan_review_codex');
      expect(result.message).toContain('RCA + Plan Validation');
    });

    test('bug-fix: proceeds to implementation after Codex plan validation approved', () => {
      const progress: PipelineProgress = {
        userStory: { title: 'Fix: test bug' },
        plan: { steps: [] },
        pipelineTasks: { pipeline_type: 'bug-fix', team_name: 'test' },
        analysisFiles: [],
        rcaSonnet: { root_cause: { summary: 'test' } },
        rcaOpus: { root_cause: { summary: 'test' } },
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: { status: 'approved' },
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('implementation');
    });

    test('bug-fix: does NOT fall into requirements_team_pending at startup', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { pipeline_type: 'bug-fix', team_name: 'test' },
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).not.toBe('requirements_team_pending');
      expect(result.phase).not.toBe('requirements_gathering');
    });

    test('multi-ai: still returns requirements_team_pending (regression check)', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: { requirements: 'T1' },
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_team_pending');
    });

    test('multi-ai: still requires Sonnet plan review before Codex (regression check)', () => {
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: { steps: [] },
        pipelineTasks: { requirements: 'T1' },
        analysisFiles: [],
        rcaSonnet: null,
        rcaOpus: null,
        planReviewSonnet: null,
        planReviewOpus: null,
        planReviewCodex: null,
        implResult: null,
        codeReviewSonnet: null,
        codeReviewOpus: null,
        codeReviewCodex: null,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('plan_review_sonnet');
    });
  });
});
