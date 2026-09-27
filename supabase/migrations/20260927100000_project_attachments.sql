-- Work Radar attachments — private metadata and Storage access.
--
-- The desktop client reserves an attachment row, uploads the immutable object,
-- then changes status to ready. Readers require both ready and nondeleted,
-- making retries safe when either side of the two-system write is interrupted.

create table public.item_attachments (
  id uuid primary key,
  item_id text not null,
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  display_filename text not null check (char_length(display_filename) between 1 and 255),
  object_key text not null unique,
  content_type text not null check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'text/csv', 'text/markdown', 'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  )),
  byte_size bigint not null check (byte_size between 0 and 10485760),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'deleted')),
  deleted_at timestamptz,
  constraint item_attachments_item_owner_fk
    foreign key (item_id, owner_id) references public.items (id, user_id)
);

create index item_attachments_owner_item_idx
  on public.item_attachments (owner_id, item_id, created_at, id);
create index item_attachments_owner_status_idx
  on public.item_attachments (owner_id, status, created_at);

comment on table public.item_attachments is
  'Private attachment metadata. Bytes live in the private project-attachments '
  'Storage bucket and become readable only after status changes to ready.';
comment on column public.item_attachments.object_key is
  'Immutable generated key: <owner id>/<item id>/<attachment id>; display '
  'filenames are metadata and never become Storage paths.';
comment on column public.item_attachments.checksum is 'Lowercase SHA-256 checksum of the attachment bytes.';

alter table public.item_attachments enable row level security;

create policy item_attachments_select_own
  on public.item_attachments for select to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.items
      where items.id = item_attachments.item_id
        and items.user_id = item_attachments.owner_id
    )
  );

create policy item_attachments_insert_own
  on public.item_attachments for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.items
      where items.id = item_attachments.item_id
        and items.user_id = item_attachments.owner_id
    )
    and object_key = owner_id::text || '/' || item_id || '/' || id::text
  );

create policy item_attachments_update_own
  on public.item_attachments for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.items
      where items.id = item_attachments.item_id
        and items.user_id = item_attachments.owner_id
    )
  );

revoke delete, truncate on public.item_attachments from anon, authenticated;
revoke all on public.item_attachments from anon;
grant select, insert, update on public.item_attachments to authenticated;

-- Metadata is immutable after reservation. Only transfer state, server time,
-- and the deletion tombstone can change; this prevents a caller from moving
-- a ready object to another project or replacing its checksum.
create or replace function public.prevent_attachment_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.item_id <> old.item_id
    or new.owner_id <> old.owner_id
    or new.display_filename <> old.display_filename
    or new.object_key <> old.object_key
    or new.content_type <> old.content_type
    or new.byte_size <> old.byte_size
    or new.checksum <> old.checksum
    or new.created_at <> old.created_at
  then
    raise exception 'attachment identity is immutable';
  end if;
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'attachment tombstones cannot be resurrected';
  end if;
  if old.status = 'deleted' and new.status <> 'deleted' then
    raise exception 'deleted attachments cannot be resurrected';
  end if;
  if new.status = 'ready' and new.deleted_at is not null then
    raise exception 'deleted attachments cannot be ready';
  end if;
  new.synced_at := now();
  return new;
end;
$$;

create trigger item_attachments_immutable_identity
  before update on public.item_attachments
  for each row execute function public.prevent_attachment_identity_change();

-- The bucket is private and has a server-side 10 MiB cap in addition to the
-- client and metadata checks. The allow-list is repeated at this boundary so
-- direct Storage calls cannot bypass the desktop validation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-attachments',
  'project-attachments',
  false,
  10485760,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'text/csv', 'text/markdown', 'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy project_attachments_select_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'project-attachments'
    and exists (
      select 1 from public.item_attachments a
      where a.object_key = storage.objects.name
        and a.owner_id = (select auth.uid())
        and a.status = 'ready'
        and a.deleted_at is null
    )
  );

create policy project_attachments_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'project-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.item_attachments a
      where a.object_key = storage.objects.name
        and a.owner_id = (select auth.uid())
        and a.status in ('pending', 'failed')
        and a.deleted_at is null
    )
  );

-- No Storage UPDATE policy: objects are immutable and uploads use upsert=false.
-- A retry either observes the existing object or creates it once; callers
-- never need to replace bytes in place.

create policy project_attachments_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'project-attachments'
    and exists (
      select 1 from public.item_attachments a
      where a.object_key = storage.objects.name
        and a.owner_id = (select auth.uid())
    )
  );
