import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createCommitment, generateId, isOverdue, isDueSoon } from './types.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class CommitmentLedger {
  constructor(filePath = null) {
    this.filePath = filePath || resolve(__dirname, '..', config.ledger.path);
    this.commitments = [];
    this.metadata = {
      version: '1.0.0',
      createdAt: null,
      updatedAt: null,
      source: null
    };
  }

  load() {
    try {
      if (!existsSync(this.filePath)) {
        return this;
      }
      const content = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(content);
      this.commitments = data.commitments || [];
      this.metadata = data.metadata || this.metadata;
      return this;
    } catch (err) {
      console.error(`Failed to load ledger: ${err.message}`);
      return this;
    }
  }

  save() {
    this.metadata.updatedAt = new Date().toISOString();
    const data = {
      version: this.metadata.version,
      commitments: this.commitments,
      metadata: this.metadata
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    return this;
  }

  add(commitment) {
    const existing = this.findSimilar(commitment);
    if (existing) {
      existing.evidence.push(...commitment.evidence);
      existing.updatedAt = new Date().toISOString();
      return existing;
    }

    const c = createCommitment({
      ...commitment,
      id: commitment.id || generateId(),
      createdAt: commitment.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    this.commitments.push(c);
    return c;
  }

  findSimilar(commitment) {
    const title = commitment.title?.toLowerCase() || '';
    const owner = commitment.owner || '';

    return this.commitments.find(c => {
      const sameOwner = (c.owner === owner) || !owner || !c.owner;
      if (!sameOwner) return false;

      const cTitle = c.title.toLowerCase();
      const similarity = this.calculateSimilarity(title, cTitle);
      if (similarity > 0.7) return true;

      const sameDeadline = commitment.deadline && c.deadline &&
        Math.abs(new Date(commitment.deadline) - new Date(c.deadline)) < 7 * 24 * 60 * 60 * 1000;
      if (sameDeadline && similarity > 0.5) return true;

      return false;
    });
  }

  calculateSimilarity(a, b) {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const aWords = new Set(a.replace(/[^\w\u4e00-\u9fff]/g, '').split(''));
    const bWords = new Set(b.replace(/[^\w\u4e00-\u9fff]/g, '').split(''));

    const intersection = [...aWords].filter(x => bWords.has(x)).length;
    const union = new Set([...aWords, ...bWords]).size;

    return union > 0 ? intersection / union : 0;
  }

  update(id, updates) {
    const c = this.commitments.find(c => c.id === id);
    if (c) {
      Object.assign(c, updates, { updatedAt: new Date().toISOString() });
    }
    return c;
  }

  appendEvidence(id, evidence) {
    const c = this.commitments.find(c => c.id === id);
    if (c) {
      c.evidence.push(evidence);
      c.updatedAt = new Date().toISOString();
    }
    return c;
  }

  getStats() {
    const total = this.commitments.length;
    const pending = this.commitments.filter(c => c.status === 'pending').length;
    const confirmed = this.commitments.filter(c => c.status === 'confirmed').length;
    const inProgress = this.commitments.filter(c => c.status === 'in_progress').length;
    const blocked = this.commitments.filter(c => c.status === 'blocked').length;
    const done = this.commitments.filter(c => c.status === 'done').length;
    const overdue = this.commitments.filter(c => isOverdue(c)).length;
    const dueSoon = this.commitments.filter(c => isDueSoon(c, 24)).length;
    const noDeadline = this.commitments.filter(c => !c.deadline).length;

    return {
      total,
      pending,
      confirmed,
      inProgress,
      blocked,
      done,
      overdue,
      dueSoon,
      noDeadline,
      byConfidence: {
        high: this.commitments.filter(c => c.confidence === 'high').length,
        medium: this.commitments.filter(c => c.confidence === 'medium').length,
        low: this.commitments.filter(c => c.confidence === 'low').length
      }
    };
  }

  getByStatus(status) {
    return this.commitments.filter(c => c.status === status);
  }

  getOverdue() {
    return this.commitments.filter(c => isOverdue(c));
  }

  getDueSoon(hours = 24) {
    return this.commitments.filter(c => isDueSoon(c, hours));
  }

  getByOwner(owner) {
    return this.commitments.filter(c => c.owner === owner);
  }

  merge(otherLedger) {
    for (const c of otherLedger.commitments) {
      this.add(c);
    }
    return this;
  }
}

export const ledger = new CommitmentLedger();
