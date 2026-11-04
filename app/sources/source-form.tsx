"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { slugify, SOURCE_COLORS } from "@/lib/study-sources";
import { STUDY_SOURCE_KIND_LABEL, STUDY_SOURCE_KINDS, type StudySourceKind } from "@/lib/types";
import { createSource, updateSource, type SourceActionResult } from "./actions";

export interface SourceFormValues {
  name: string;
  nameJa: string | null;
  kind: StudySourceKind;
  level: string | null;
  edition: string | null;
  url: string | null;
  color: string | null;
  aliases: string[];
  description: string | null;
  howUsed: string | null;
}

type Props =
  | { mode: "new"; initialColor: string }
  | {
      mode: "edit";
      id: string;
      slug: string;
      active: boolean;
      imageUrl: string | null;
      blobEnabled: boolean;
      values: SourceFormValues;
    };

const INPUT =
  "w-full rounded-xl border border-neutral-300 bg-white p-2.5 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-indigo-900";
const LABEL = "text-sm font-medium text-neutral-600 dark:text-neutral-300";

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={LABEL}>
        {label} {hint && <span className="text-neutral-400">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

/** One form for both /sources/new and /sources/[slug]/edit; the edit variant adds active + image controls. */
export function SourceForm(props: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const v: SourceFormValues =
    props.mode === "edit"
      ? props.values
      : { name: "", nameJa: null, kind: "textbook", level: null, edition: null, url: null, color: props.initialColor, aliases: [], description: null, howUsed: null };
  const [name, setName] = useState(v.name);
  const [color, setColor] = useState(v.color ?? SOURCE_COLORS[0]);
  const derivedSlug = props.mode === "new" ? slugify(name, "(generated id)") : props.slug;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result: SourceActionResult =
        props.mode === "new" ? await createSource(formData) : await updateSource(props.id, formData);
      if (result.ok) {
        router.push(`/sources/${result.slug}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
        {props.mode === "new" ? "New source" : "Edit source"}
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="name" label="Name">
          <input id="name" name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Shin Kanzen Master N4 Grammar" className={INPUT} />
          <p className="text-xs text-neutral-400">
            Slug: <code>{derivedSlug}</code>
            {props.mode === "new" ? " (from the name; permanent once created)" : " (fixed)"}
          </p>
        </Field>
        <Field id="nameJa" label="Japanese title" hint="optional">
          <input id="nameJa" name="nameJa" defaultValue={v.nameJa ?? ""} placeholder="新完全マスター文法 N4" className={INPUT} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="kind" label="Kind">
          <select id="kind" name="kind" defaultValue={v.kind} className={INPUT}>
            {STUDY_SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {STUDY_SOURCE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="level" label="Level" hint="optional">
          <input id="level" name="level" defaultValue={v.level ?? ""} placeholder="N4, N5, N4-N5" className={INPUT} />
        </Field>
        <Field id="color" label="Colour">
          <div className="flex items-center gap-2">
            <input
              id="color"
              name="color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-10 w-12 cursor-pointer rounded-lg border border-neutral-300 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <div className="flex flex-wrap gap-1">
              {SOURCE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Use ${c}`}
                  onClick={() => setColor(c)}
                  className={`h-5 w-5 rounded-full border-2 ${c === color ? "border-neutral-900 dark:border-white" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="edition" label="Edition / publisher" hint="optional">
          <input id="edition" name="edition" defaultValue={v.edition ?? ""} placeholder="3rd edition, The Japan Times" className={INPUT} />
        </Field>
        <Field id="url" label="URL" hint="optional">
          <input id="url" name="url" type="url" defaultValue={v.url ?? ""} placeholder="https://" className={INPUT} />
        </Field>
      </div>

      <Field id="aliases" label="Aliases" hint="comma-separated; other names a log might use">
        <input id="aliases" name="aliases" defaultValue={v.aliases.join(", ")} placeholder="SKM N4 文法, Shin Kanzen Master N4 Bunpou" className={INPUT} />
      </Field>

      <Field id="description" label="Description" hint="what it is">
        <textarea id="description" name="description" rows={2} defaultValue={v.description ?? ""} className={INPUT} />
      </Field>

      <Field id="howUsed" label="How it is used" hint="in the study plan; the logging agent reads this">
        <textarea
          id="howUsed"
          name="howUsed"
          rows={2}
          defaultValue={v.howUsed ?? ""}
          placeholder="Grammar lessons: open-book examples + れんしゅう, logged as lesson sessions"
          className={INPUT}
        />
      </Field>

      {props.mode === "edit" && (
        <>
          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" name="active" defaultChecked={props.active} className="h-4 w-4 accent-indigo-600" />
            Active <span className="text-neutral-400">(inactive sources are hidden from the grid and the practice form, never deleted)</span>
          </label>

          <fieldset className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <legend className="px-1 text-sm font-medium text-neutral-600 dark:text-neutral-300">Image</legend>
            {props.imageUrl ? (
              <p className="truncate text-xs text-neutral-400">
                Current: <code>{props.imageUrl}</code>
              </p>
            ) : (
              <p className="text-xs text-neutral-400">
                No image set — the placeholder card shows, or a file at <code>public/sources/{props.slug}.jpg</code> if one exists.
              </p>
            )}
            <Field id="image" label="Upload" hint="JPEG/PNG/WebP, up to 5 MB">
              <input
                id="image"
                name="image"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="w-full rounded-xl border border-dashed border-neutral-300 bg-white p-2.5 text-sm text-neutral-500 outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:file:bg-neutral-800 dark:file:text-neutral-200"
              />
              {!props.blobEnabled && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Blob storage is not configured (no <code>BLOB_READ_WRITE_TOKEN</code>): an upload is saved to{" "}
                  <code>public/sources/</code> on this machine only and will not survive a deploy. Pasting a URL below works everywhere.
                </p>
              )}
            </Field>
            <Field id="imageUrl" label="Or image URL" hint="optional">
              <input id="imageUrl" name="imageUrl" defaultValue={props.imageUrl ?? ""} placeholder="https://…/cover.jpg" className={INPUT} />
            </Field>
            {props.imageUrl && (
              <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
                <input type="checkbox" name="removeImage" className="h-4 w-4 accent-indigo-600" />
                Remove the current image (back to the placeholder)
              </label>
            )}
          </fieldset>
        </>
      )}

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
        >
          {pending ? "Saving…" : props.mode === "new" ? "Add source" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm text-neutral-400 transition hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
