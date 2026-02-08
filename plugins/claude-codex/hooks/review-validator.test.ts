import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// Import functions to test
import {
  validatePlanReview,
  validateCodeReview
} from './review-validator.ts';

const TEST_DIR = join(import.meta.dir, '.test-task');

describe('review-validator', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = join(import.meta.dir, '.test-task').replace('.task', '');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('validateCodeReview', () => {
    test('returns null (valid) when no ACs in user story', () => {
      const userStory = { acceptance_criteria: [] as Array<{ id: string }> };
      const review = { status: 'approved' };

      const result = validateCodeReview(review, userStory);
      expect(result).toBeNull();
    });

    test('returns null (valid) when no user story', () => {
      const review = { status: 'approved' };

      const result = validateCodeReview(review, null);
      expect(result).toBeNull();
    });

    test('blocks when acceptance_criteria_verification missing', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        summary: 'Looks good'
        // Missing acceptance_criteria_verification
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('acceptance_criteria_verification');
    });

    test('blocks when not all ACs are verified', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }, { id: 'AC3' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'IMPLEMENTED', evidence: '', notes: '' }
            // Missing AC3
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC3');
    });

    test('blocks approval with unimplemented ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'NOT_IMPLEMENTED', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC2');
      expect(result!.reason).toContain('needs_changes');
    });

    test('allows valid approval with all ACs implemented', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'IMPLEMENTED', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).toBeNull();
    });

    test('allows needs_changes with unimplemented ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'needs_changes',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'NOT_IMPLEMENTED', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).toBeNull();
    });

    test('blocks approval with PARTIAL ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'PARTIAL', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC2');
      expect(result!.reason).toContain('incomplete');
    });

    test('allows needs_changes with PARTIAL ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'needs_changes',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'PARTIAL', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).toBeNull();
    });
  });

  describe('validatePlanReview', () => {
    test('returns null (valid) when no ACs in user story', () => {
      const userStory = { acceptance_criteria: [] as Array<{ id: string }> };
      const review = { status: 'approved' };

      const result = validatePlanReview(review, userStory);
      expect(result).toBeNull();
    });

    test('blocks when requirements_coverage missing', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        summary: 'Plan looks good'
        // Missing requirements_coverage
      };

      const result = validatePlanReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('requirements_coverage');
    });

    test('blocks when not all ACs are covered', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }, { id: 'AC3' }]
      };
      const review = {
        status: 'approved',
        requirements_coverage: {
          mapping: [
            { ac_id: 'AC1', steps: ['Step 1'] },
            { ac_id: 'AC2', steps: ['Step 2'] }
            // Missing AC3
          ]
        }
      };

      const result = validatePlanReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC3');
    });

    test('blocks approval with missing requirements', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        requirements_coverage: {
          mapping: [
            { ac_id: 'AC1', steps: ['Step 1'] },
            { ac_id: 'AC2', steps: ['Step 2'] }
          ],
          missing: ['AC2']
        }
      };

      const result = validatePlanReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC2');
    });

    test('allows valid approval with all ACs covered', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        requirements_coverage: {
          mapping: [
            { ac_id: 'AC1', steps: ['Step 1'] },
            { ac_id: 'AC2', steps: ['Step 2'] }
          ],
          missing: []
        }
      };

      const result = validatePlanReview(review, userStory);
      expect(result).toBeNull();
    });
  });
});
