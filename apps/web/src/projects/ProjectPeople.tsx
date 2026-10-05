import { Badge, Button, Card, Dialog, Field, Select, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import {
  PROJECT_PARTY_ROLES,
  type Project,
  type ProjectPartyLink,
  type ProjectPartyRole,
} from '../api/projects.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { refreshCrm } from '../leads/crm.js';
import { PartyPicker } from '../parties/PartyPicker.js';

function AddPersonDialog({
  onAdd,
  onClose,
}: {
  readonly onAdd: (partyId: string, role: ProjectPartyRole) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { t, label } = useI18n();
  const [role, setRole] = useState<ProjectPartyRole>('contractor');
  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={t('projects.people.addTitle')}
      description={t('projects.people.addHint')}
      closeLabel={t('common.close')}
    >
      <div className="stack">
        <Field label={t('projects.people.role')}>
          <Select
            value={role}
            onChange={(event) => {
              setRole(event.target.value as ProjectPartyRole);
            }}
          >
            {PROJECT_PARTY_ROLES.map((value) => (
              <option key={value} value={value}>
                {label('partyRoles', value)}
              </option>
            ))}
          </Select>
        </Field>
        <PartyPicker
          title={t('projects.people.find')}
          onPick={(party) => {
            void onAdd(party.id, role);
          }}
        />
      </div>
    </Dialog>
  );
}

/**
 * Who works on the project: its customer (the owner), then any number of
 * architects, contractors, painters and dealers, added and removed here.
 */
export function ProjectPeople({
  project,
  canChange,
}: {
  readonly project: Project;
  readonly canChange: boolean;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const links: ProjectPartyLink[] = project.parties.map(({ partyId, role }) => ({ partyId, role }));

  /** Saves the whole list (the API replaces it), then says how it went. */
  const save = async (next: ProjectPartyLink[], done: string): Promise<boolean> => {
    try {
      await api.projects.setParties(project.id, next);
      toast({ title: done, tone: 'success' });
      return true;
    } catch (error) {
      toast({ title: t('leads.actions.failed'), description: errorMessage(error), tone: 'danger' });
      return false;
    } finally {
      await refreshCrm(queryClient);
    }
  };

  return (
    <Card
      title={t('projects.people.title')}
      actions={
        canChange ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('projects.people.add')}
          </Button>
        ) : undefined
      }
    >
      <ul className="record-list" aria-label={t('projects.people.title')}>
        <li className="record-list__row">
          <span className="picker__who">
            <Link className="record-list__title" to={`/parties/${project.customer.id}`}>
              {project.customer.name}
            </Link>
            <span className="record-list__meta">{project.customer.phone}</span>
          </span>
          <Badge tone="primary">{t('projects.people.owner')}</Badge>
        </li>
        {project.parties.map((person) => (
          <li key={`${person.partyId}:${person.role}`} className="record-list__row">
            <span className="picker__who">
              <Link className="record-list__title" to={`/parties/${person.partyId}`}>
                {person.name}
              </Link>
              <span className="record-list__meta">{person.phone}</span>
            </span>
            <span className="row">
              <Badge>{label('partyRoles', person.role)}</Badge>
              {canChange && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('projects.people.removeName', {
                    name: person.name,
                    role: label('partyRoles', person.role),
                  })}
                  onClick={() => {
                    void save(
                      links.filter(
                        (link) => !(link.partyId === person.partyId && link.role === person.role),
                      ),
                      t('projects.people.removed', { name: person.name }),
                    );
                  }}
                >
                  {t('projects.people.remove')}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {project.parties.length === 0 && <p className="muted">{t('projects.people.none')}</p>}
      {adding && (
        <AddPersonDialog
          onClose={() => {
            setAdding(false);
          }}
          onAdd={async (partyId, role) => {
            if (links.some((link) => link.partyId === partyId && link.role === role)) {
              toast({ title: t('projects.people.already'), tone: 'info' });
              return;
            }
            const saved = await save(
              [...links, { partyId, role }],
              t('projects.people.added', { role: label('partyRoles', role) }),
            );
            if (saved) setAdding(false);
          }}
        />
      )}
    </Card>
  );
}
