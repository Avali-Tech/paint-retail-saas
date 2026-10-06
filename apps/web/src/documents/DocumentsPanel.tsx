import '../styles/customers.css';
import { Badge, Button, Card, Field, Input, Select, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_PERMISSIONS,
  type DocumentCategory,
  type DocumentFile,
  type DocumentRecordType,
} from '../api/documents.js';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import { ACCEPTED_FILES, checkFile, sizeParts, uploadRefusal } from './file-checks.js';

export interface DocumentsPanelProps {
  /** The kind of record the documents belong to, e.g. "party", "contract" or "project". */
  readonly recordType: DocumentRecordType;
  readonly recordId: string;
  /** What new uploads are by default, e.g. "contract" on a contract or "before_photo" on a project. */
  readonly defaultCategory?: DocumentCategory;
}

export const documentsKey = (recordType: DocumentRecordType, recordId: string) =>
  ['documents', recordType, recordId] as const;

function UploadDialog({
  recordType,
  recordId,
  defaultCategory,
  onClose,
}: Required<DocumentsPanelProps> & { readonly onClose: () => void }) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<DocumentCategory>(defaultCategory);
  const [note, setNote] = useState('');

  const upload = async (chosen: File) => {
    const problem = await checkFile(chosen);
    if (problem !== null) return t(`documents.problems.${problem}`);
    try {
      await api.documents.upload({
        recordType,
        recordId,
        category,
        file: chosen,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
    } catch (error) {
      const refusal = uploadRefusal(error);
      if (refusal === null) throw error;
      return t(`documents.problems.${refusal}`, { detail: errorMessage(error) });
    }
    await queryClient.invalidateQueries({ queryKey: documentsKey(recordType, recordId) });
    toast({ title: t('documents.uploaded'), tone: 'success' });
    return undefined;
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('documents.uploadTitle')}
      description={t('documents.uploadHint')}
      submitLabel={t('documents.save')}
      onSubmit={() => (file === null ? t('documents.problems.noFile') : upload(file))}
    >
      <Field label={t('documents.file')} required>
        <Input
          type="file"
          accept={ACCEPTED_FILES}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
          }}
        />
      </Field>
      <Field label={t('documents.category')}>
        <Select
          value={category}
          onChange={(event) => {
            setCategory(event.target.value as DocumentCategory);
          }}
        >
          {DOCUMENT_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {label('documentCategories', value)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('documents.note')} hint={t('documents.noteHint')}>
        <Input
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function DocumentRow({
  document,
  canManage,
  onRemove,
}: {
  readonly document: DocumentFile;
  readonly canManage: boolean;
  readonly onRemove: (document: DocumentFile) => void;
}) {
  const api = useApi();
  const { t, label, date } = useI18n();
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const { unit, size } = sizeParts(document.sizeBytes);
  const sizeKey = { B: 'sizeBytes', KB: 'sizeKb', MB: 'sizeMb' } as const;

  const download = async () => {
    setDownloading(true);
    try {
      const file = await api.documents.download(document.id);
      // The server's cleaned name; ours if it sent none.
      saveFile(file.blob, file.fileName ?? document.fileName);
    } catch (error) {
      toast({
        title: t('documents.downloadFailed'),
        description: errorMessage(error),
        tone: 'danger',
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="record-list__row">
      <span className="picker__who">
        <span className="record-list__title">{document.fileName}</span>
        <span className="record-list__meta">
          {t('documents.meta', {
            category: label('documentCategories', document.category),
            size: t(`documents.${sizeKey[unit]}`, { size }),
            name: document.uploadedBy.name,
            date: date(document.createdAt),
          })}
        </span>
        {document.note !== null && <span className="record-list__meta">{document.note}</span>}
      </span>
      <span className="row">
        <Button
          size="sm"
          variant="secondary"
          loading={downloading}
          aria-label={t('documents.download', { name: document.fileName })}
          onClick={() => {
            void download();
          }}
        >
          {t('documents.downloadButton')}
        </Button>
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('documents.removeName', { name: document.fileName })}
            onClick={() => {
              onRemove(document);
            }}
          >
            {t('documents.remove')}
          </Button>
        )}
      </span>
    </li>
  );
}

/**
 * A record's documents: the list, downloads (fetched with the session's token,
 * saved under the server's file name), uploads checked before sending, and
 * deleting, each for members whose role allows it on that kind of record.
 * Any screen with a record shows it with the record's type and id.
 */
export function DocumentsPanel({
  recordType,
  recordId,
  defaultCategory = 'other',
}: DocumentsPanelProps) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const rule = DOCUMENT_PERMISSIONS[recordType];
  const canManage = can(rule.manage);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<DocumentFile | null>(null);
  const documents = useQuery({
    queryKey: documentsKey(recordType, recordId),
    queryFn: ({ signal }) => api.documents.list(recordType, recordId, signal),
    enabled: can(rule.read),
  });
  if (!can(rule.read)) return null;

  return (
    <Card
      title={t('documents.title')}
      actions={
        <span className="row">
          <Badge>{String(documents.data?.length ?? 0)}</Badge>
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setUploading(true);
              }}
            >
              {t('documents.upload')}
            </Button>
          )}
        </span>
      }
    >
      <QueryState query={documents} error="documents.error">
        {(list) =>
          list.length === 0 ? (
            <p className="muted">{t('documents.empty')}</p>
          ) : (
            <ul className="record-list">
              {list.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  canManage={canManage}
                  onRemove={setRemoving}
                />
              ))}
            </ul>
          )
        }
      </QueryState>
      {uploading && (
        <UploadDialog
          recordType={recordType}
          recordId={recordId}
          defaultCategory={defaultCategory}
          onClose={() => {
            setUploading(false);
          }}
        />
      )}
      {removing !== null && (
        <FormDialog
          open
          onClose={() => {
            setRemoving(null);
          }}
          title={t('documents.removeTitle', { name: removing.fileName })}
          description={t('documents.removeDescription')}
          submitLabel={t('documents.remove')}
          onSubmit={async () => {
            await api.documents.remove(removing.id);
            await queryClient.invalidateQueries({
              queryKey: documentsKey(recordType, recordId),
            });
            toast({ title: t('documents.removed'), tone: 'success' });
            return undefined;
          }}
        >
          {null}
        </FormDialog>
      )}
    </Card>
  );
}
