import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MedicalSource } from '../dto/medical-source.dto';

type EvidenceLevel = NonNullable<MedicalSource['evidenceLevel']>;

const VALID_EVIDENCE_LEVELS = new Set<EvidenceLevel>([
  'A',
  'B',
  'C',
  'expert_opinion',
]);

/**
 * Registry JSON is untrusted disk input.
 *
 * `evidence_grade` is stored as a free-form string, while
 * `MedicalSource.evidenceLevel` is a closed literal union.
 *
 * Unknown values are returned as undefined instead of being forcefully
 * converted into a valid evidence level.
 */
function normalizeEvidenceLevel(
  value: string | undefined,
): MedicalSource['evidenceLevel'] {
  if (!value) {
    return undefined;
  }

  return VALID_EVIDENCE_LEVELS.has(value as EvidenceLevel)
    ? (value as EvidenceLevel)
    : undefined;
}

export interface RegistryArtifactLite {
  id: string;
  title?: string;
  specialty?: string;
  topic?: string;
  evidence_grade?: string;
  jurisdiction?: string;
  review_status?: string;
  expires_at?: string | null;
  rag_ingest_allowed?: boolean;
  license?: string;
  content_path?: string;
  publisher?: string;
}

/**
 * Load knowledge-registry artifact files for metadata enrichment during
 * document ingestion.
 *
 * The method checks paths relative to both the repository root and backend
 * directory because the application may be started from different working
 * directories.
 */
export function loadKnowledgeRegistryArtifacts(
  repoRoot = process.cwd(),
): RegistryArtifactLite[] {
  const candidates = [
    join(repoRoot, 'data', 'knowledge-registry', 'artifacts'),
    join(repoRoot, '..', 'data', 'knowledge-registry', 'artifacts'),
  ];

  for (const directory of candidates) {
    if (!existsSync(directory)) {
      continue;
    }

    try {
      return readdirSync(directory)
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => {
          const filePath = join(directory, fileName);
          const fileContents = readFileSync(filePath, 'utf8');

          return JSON.parse(fileContents) as RegistryArtifactLite;
        });
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Find the registry artifact associated with a MedicalSource.
 *
 * Matching priority:
 * 1. Exact artifact ID match
 * 2. Content-path match against the source URL
 * 3. Partial title match
 */
export function findRegistryArtifactForSource(
  source: MedicalSource,
  artifacts: RegistryArtifactLite[],
): RegistryArtifactLite | undefined {
  const artifactById = artifacts.find(
    (artifact) => artifact.id === source.id,
  );

  if (artifactById) {
    return artifactById;
  }

  const sourceTitle = String(source.title ?? '')
    .trim()
    .toLowerCase();

  return artifacts.find((artifact) => {
    if (
      artifact.content_path &&
      source.url &&
      source.url.includes(artifact.content_path)
    ) {
      return true;
    }

    if (artifact.title && sourceTitle) {
      const artifactTitle = artifact.title.trim().toLowerCase();
      const titlePrefix = sourceTitle.slice(0, 24);

      return Boolean(titlePrefix) && artifactTitle.includes(titlePrefix);
    }

    return false;
  });
}

/**
 * Merge knowledge-registry provenance metadata into a MedicalSource.
 *
 * Existing source values take priority. Registry fields are used only when
 * the corresponding source values are missing.
 */
export function enrichSourceWithRegistry(
  source: MedicalSource,
  artifact?: RegistryArtifactLite,
): MedicalSource {
  if (!artifact) {
    return source;
  }

  return {
    ...source,

    id: artifact.id || source.id,

    title:
      source.title ||
      artifact.title ||
      source.id,

    organization:
      source.organization ||
      artifact.publisher,

    specialty:
      source.specialty ||
      artifact.specialty,

    evidenceLevel:
      source.evidenceLevel ||
      normalizeEvidenceLevel(artifact.evidence_grade),

    authoritative:
      source.authoritative ??
      (
        artifact.review_status === 'accepted' ||
        artifact.review_status === 'accepted_with_limitations'
      ),

    metadata: {
      ...(source.metadata ?? {}),

      artifactId: artifact.id,
      evidenceGrade: artifact.evidence_grade,
      jurisdiction: artifact.jurisdiction,
      reviewStatus: artifact.review_status,
      expiresAt: artifact.expires_at,
      ragIngestAllowed: artifact.rag_ingest_allowed,
      license: artifact.license,
      topic: artifact.topic,
      knowledgeRegistry: true,
    },
  };
}
