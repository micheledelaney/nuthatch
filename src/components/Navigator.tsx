import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { OBJECT_TYPE_META, objectLabel, type FmFile, type FmObject, type ObjectType } from "@/types/ddr";
import { TypePill } from "./TypePill";
import { applyNavFilters, effectiveRefFilter, isUnreferenced, type NavFilters } from "./browseA/filters";
import { brokenSourcesFor, refStatsFor } from "./browseA/refStats";
import { FilterMenu } from "./browseA/FilterChips";

const GROUP_LIMIT = 500;
const BASE_PAD = 12;
const INDENT = 16;

interface NavGroup {
  type: ObjectType;
  items: FmObject[];
}

/** A top-level file section, or a single null-file section when only one file
 * is loaded (in which case the type groups render at the top level as before). */
interface FileSection {
  file: FmFile | null;
  /** The file's own object, rendered as the lead node under the header when it
   * passes the active filter (it's filtered like any other object). */
  fileNode: FmObject | null;
  groups: NavGroup[];
  /** Real (non-separator) object count, shown beside the file header. */
  count: number;
}

/** Navigator: a title row (type + count) with the filter menu, and a grouped object list
 * with a true nested folder tree for scripts. With multiple files loaded, files
 * are the uppermost level and the type groups nest beneath each file. */
export function Navigator() {
  const model = useStore((s) => s.model);
  const trail = useStore((s) => s.trail);
  const openObject = useStore((s) => s.openObject);
  const typeFilter = useStore((s) => s.navType);
  const fieldFilter = useStore((s) => s.navFieldFilter);
  const dataType = useStore((s) => s.navDataType);
  const relFilter = useStore((s) => s.navRelFilter);
  const accountFilter = useStore((s) => s.navAccountFilter);
  const accountPriv = useStore((s) => s.navAccountPriv);
  const accountPw = useStore((s) => s.navAccountPw);
  const privCap = useStore((s) => s.navPrivCap);
  const refFilter = useStore((s) => s.navRefFilter);
  const layoutFilter = useStore((s) => s.navLayoutFilter);
  const layoutObjectType = useStore((s) => s.navLayoutObjectType);
  const layoutObjectFilter = useStore((s) => s.navLayoutObjectFilter);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  // Which file + type group is currently scrolled to the top, mirrored by the
  // floating header below (file row pinned, type row swapping beneath it).
  const [pinned, setPinned] = useState<{ fileUid: string | null; typeKey: string | null }>({
    fileUid: null,
    typeKey: null,
  });
  // The last file uid we applied the push transform for. Used to detect a
  // file-to-file handoff during scroll: setPinned re-renders the floating
  // header's text asynchronously, so resetting the transform synchronously
  // would paint the OLD file's name at the new (transform=0) position for one
  // frame. When the file is changing we skip the synchronous applyPush and let
  // useLayoutEffect re-apply it after React commits the new text.
  const lastPushedFileRef = useRef<string | null>(null);
  const activeUid = trail[0];
  // The field sub-filters only apply when the field type is selected.
  const fieldFiltering = typeFilter === "field" && (fieldFilter !== "all" || dataType !== "all");
  const layoutObjectFiltering = typeFilter === "layoutObject" && (layoutObjectType !== "all" || layoutObjectFilter !== "all");
  // The stored reference-status mode is clamped to "all" when it doesn't apply
  // to this type, so it re-applies when switching back to a compatible type.
  const effRefFilter = effectiveRefFilter(typeFilter, refFilter);
  const refFiltering = effRefFilter !== "all";

  const filters = useMemo<NavFilters>(
    () => ({
      field: fieldFilter,
      dataType,
      rel: relFilter,
      account: accountFilter,
      accountPw,
      accountPriv,
      privCap,
      ref: refFilter,
      layout: layoutFilter,
      loType: layoutObjectType,
      loFilter: layoutObjectFilter,
    }),
    [fieldFilter, dataType, relFilter, accountFilter, accountPw, accountPriv, privCap, refFilter, layoutFilter, layoutObjectType, layoutObjectFilter],
  );

  // The selected type's objects before any chip narrows them — also the base the
  // chips count against.
  const baseObjects = useMemo<FmObject[]>(() => {
    if (!model) return [];
    return model.objects.filter((o) => typeFilter === "all" || o.type === typeFilter);
  }, [model, typeFilter]);

  const filteredObjects = useMemo<FmObject[]>(
    () => (model ? applyNavFilters(model, baseObjects, typeFilter, filters) : []),
    [model, baseObjects, typeFilter, filters],
  );
  // Title-row counts: separators are dividers, not objects.
  const totalCount = useMemo(() => baseObjects.filter((o) => !o.isSeparator).length, [baseObjects]);
  const shownCount = useMemo(() => filteredObjects.filter((o) => !o.isSeparator).length, [filteredObjects]);

  const sections = useMemo<FileSection[]>(() => {
    if (!model) return [];
    const objects = filteredObjects;

    // The file's own object renders as the lead node under its header rather than
    // inside a by-type group, so split it out. It still passed the active filter
    // like any other object, so it only appears when it survived the filtering.
    const fileNodes = new Map<string, FmObject>();
    for (const o of objects) if (o.type === "file") fileNodes.set(o.fileUid, o);
    const nonFile = objects.filter((o) => o.type !== "file");

    // Single file: still show the file name as a header, with type groups nested
    // under it — the same shape as the multi-file layout.
    if (model.files.length <= 1) {
      const f = model.files[0] ?? null;
      return [
        {
          file: f,
          fileNode: f ? fileNodes.get(f.uid) ?? null : null,
          groups: groupByType(nonFile),
          count: nonFile.filter((o) => !o.isSeparator).length,
        },
      ];
    }

    const byFile = new Map<string, FmObject[]>();
    for (const obj of nonFile) {
      const list = byFile.get(obj.fileUid);
      if (list) list.push(obj);
      else byFile.set(obj.fileUid, [obj]);
    }
    return model.files
      .filter((f) => byFile.has(f.uid) || fileNodes.has(f.uid))
      .map((f) => {
        const items = byFile.get(f.uid) ?? [];
        return {
          file: f,
          fileNode: fileNodes.get(f.uid) ?? null,
          groups: groupByType(items),
          count: items.filter((o) => !o.isSeparator).length,
        };
      });
  }, [model, filteredObjects]);

  // Position the floating header. As a sticky child it pins at the top and the
  // browser keeps it aligned with the real header during overscroll. The
  // negative margin makes it overlay the rows beneath instead of reserving
  // space, and the push slides it up when an incoming file below overlaps it, so
  // files hand off cleanly (no gap, no doubled header).
  const applyPush = () => {
    const el = scrollRef.current;
    const fl = floatRef.current;
    if (!el || !fl) return;
    const listTop = el.getBoundingClientRect().top;
    const floatH = fl.offsetHeight;
    fl.style.marginBottom = `${-floatH}px`;
    let push = 0;
    // Requiring an active file above the candidate stops the first file's own
    // header from being treated as an incoming pusher during top overscroll.
    let seenActive = false;
    for (const h of Array.from(el.querySelectorAll<HTMLElement>("[data-nav-kind='file']"))) {
      const top = h.getBoundingClientRect().top - listTop;
      if (top <= 0.5) {
        seenActive = true;
        continue;
      }
      if (seenActive && top < floatH) push = top - floatH;
      break;
    }
    fl.style.transform = push ? `translateY(${push}px)` : "";
  };

  // On scroll (and when the list reshapes) read which file + type group sits at
  // the top. The file is the last file header scrolled to the fold; the type is
  // the last type header that has reached its dock (one file-row height down),
  // scoped to the active file.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const recompute = () => {
      raf = 0;
      const listTop = el.getBoundingClientRect().top;
      const fileRow = el.querySelector<HTMLElement>("[data-nav-kind='file']");
      const fileH = fileRow ? fileRow.offsetHeight : 37;
      let fileUid: string | null = null;
      let typeKey: string | null = null;
      let firstFileUid: string | null = null;
      for (const h of Array.from(el.querySelectorAll<HTMLElement>("[data-nav-kind]"))) {
        const top = h.getBoundingClientRect().top - listTop;
        if (h.dataset.navKind === "file") {
          if (firstFileUid === null) firstFileUid = h.dataset.fileUid ?? null;
          if (top <= 0.5) {
            fileUid = h.dataset.fileUid ?? null;
            typeKey = null;
          }
        } else if (top <= fileH + 0.5) {
          // Only an expanded group is worth pinning — a collapsed one has no
          // items to scroll within, so the type row stays hidden over it.
          typeKey = h.dataset.open === "1" ? (h.dataset.typeKey ?? null) : null;
        }
      }
      // Above the first file header (the very top / overscroll bounce) nothing is
      // "scrolled past" yet — hold the first file so the overlay doesn't blink.
      if (fileUid === null) {
        fileUid = firstFileUid;
        typeKey = null;
      }
      setPinned((prev) =>
        prev.fileUid === fileUid && prev.typeKey === typeKey ? prev : { fileUid, typeKey },
      );
      // Skip applyPush across a file handoff — React hasn't committed the new
      // file name yet, and resetting transform to 0 now would briefly paint the
      // old name at the new position. useLayoutEffect runs applyPush after the
      // commit, so the text and transform update in the same paint.
      if (lastPushedFileRef.current !== fileUid) return;
      applyPush();
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(recompute);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    recompute();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sections, expanded, openGroups, collapsedFiles]);

  // Re-apply the push offset after the floating header re-renders (its height
  // changes as the active file/group changes), so it stays correct at rest.
  // Also records the file we just settled on, so the scroll handler knows the
  // handoff is complete and can resume applying push transforms synchronously.
  useLayoutEffect(() => {
    applyPush();
    lastPushedFileRef.current = pinned.fileUid;
  });

  // Bring the active object's row into view when it changes (e.g. opened from
  // the relationship graph), so the navigator's selection is actually visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeUid) return;
    el.querySelector(".node.selected")?.scrollIntoView({ block: "nearest" });
  }, [activeUid, sections]);

  // Global arrow-key navigation: up/down through the visible list. (← for back
  // lives in the pane's HistoryBar so it follows the active split pane.)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "SELECT") return;
        e.preventDefault();
        const nodes = Array.from(
          scrollRef.current?.querySelectorAll<HTMLElement>("[data-uid]") ?? [],
        );
        if (nodes.length === 0) return;
        const currentIndex = nodes.findIndex((n) => n.dataset.uid === activeUid);
        const nextIndex =
          e.key === "ArrowDown"
            ? currentIndex < 0 ? 0 : (currentIndex + 1) % nodes.length
            : currentIndex <= 0 ? nodes.length - 1 : currentIndex - 1;
        const nextNode = nodes[nextIndex];
        const nextUid = nextNode?.dataset.uid;
        if (nextUid) {
          openObject(nextUid);
          nextNode?.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeUid, openObject]);

  if (!model) return null;
  const brokenSources = brokenSourcesFor(model);

  // Resolve the tracked ids back to the live section/group for the floating header.
  const pinnedSection = pinned.fileUid ? sections.find((s) => s.file?.uid === pinned.fileUid) : undefined;
  const pinnedFile = pinnedSection?.file ?? null;
  const pinnedType = pinned.typeKey
    ? sections
      .flatMap((s) => s.groups.map((g) => ({ key: `${s.file?.uid ?? ""}:${g.type}`, g })))
      .find((e) => e.key === pinned.typeKey)?.g
    : undefined;

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleGroup = (key: string, open: boolean) => {
    if (open) {
      setCollapsedGroups((prev) => { const n = new Set(prev); n.add(key); return n; });
      setOpenGroups((prev) => { const n = new Set(prev); n.delete(key); return n; });
    } else {
      setCollapsedGroups((prev) => { const n = new Set(prev); n.delete(key); return n; });
      setOpenGroups((prev) => { const n = new Set(prev); n.add(key); return n; });
    }
  };

  const toggleFile = (uid: string) =>
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });

  const renderLeaf = (obj: FmObject, depth: number) => {
    if (obj.isSeparator) {
      return <div key={obj.uid} className="nav-divider" style={{ marginLeft: BASE_PAD + depth * INDENT }} title={obj.name} />;
    }
    const stats = refStatsFor(model, obj.uid);
    const broken = brokenSources.has(obj.uid);
    const unref = isUnreferenced(model, obj);
    const hint = `${objectLabel(obj)}\n← referenced by ${stats.inbound} · references ${stats.outbound} →${broken ? `\n${stats.broken} broken reference${stats.broken === 1 ? "" : "s"}` : ""}${unref ? "\nUnreferenced" : ""}`;
    return (
      <div
        key={obj.uid}
        data-uid={obj.uid}
        className={`node lib-row${obj.uid === activeUid ? " selected" : ""}${unref ? " unref" : ""}`}
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
        onClick={() => openObject(obj.uid)}
        title={hint}
      >
        {typeFilter === "all" && <TypePill type={obj.type} short />}
        <span className="ellipsis">{objectLabel(obj)}</span>
        <span className="lib-row-meta">
          {broken && <span className="lib-broken-dot" aria-label="Has broken references" />}
          <span className={`lib-count${stats.inbound === 0 ? " zero" : ""}`}>←{stats.inbound}</span>
          <span className={`lib-count${stats.outbound === 0 ? " zero" : ""}`}>→{stats.outbound}</span>
        </span>
      </div>
    );
  };

  const renderTree = (node: TreeNode, depth: number): React.ReactNode =>
    trimSeparators(node.children).map((child) => {
      if (isTreeNode(child)) {
        const open = refFiltering || expanded.has(child.path);
        return (
          <div key={`d-${child.path}`}>
            <div
              className="folder-header clickable"
              style={{ paddingLeft: BASE_PAD + depth * INDENT }}
              onClick={() => toggle(child.path)}
              title={child.path}
            >
              <span className={`fchevron${open ? " open" : ""}`}>›</span>
              <FolderIcon />
              <span className="folder-name">{child.name}</span>
            </div>
            {open && renderTree(child, depth + 1)}
          </div>
        );
      }
      return renderLeaf(child, depth);
    });

  /** Layout objects grouped by their parent layout, same pattern as fields by table. */
  const renderLayoutObjectsByLayout = (items: FmObject[], fileUid: string | null, depthOffset: number) => {
    // Walk up parentUid chain until we reach a "layout" object.
    function ancestorLayout(obj: FmObject): FmObject | null {
      let uid = obj.parentUid;
      while (uid) {
        const parent = model?.byUid.get(uid);
        if (!parent) return null;
        if (parent.type === "layout") return parent;
        uid = parent.parentUid;
      }
      return null;
    }

    const byLayout = new Map<string, FmObject[]>();
    for (const obj of items) {
      const layout = ancestorLayout(obj);
      const key = layout?.uid ?? "";
      const list = byLayout.get(key);
      if (list) list.push(obj);
      else byLayout.set(key, [obj]);
    }
    const layoutGroups = [...byLayout.entries()]
      .map(([layoutUid, objects]) => ({
        layoutUid,
        name: (layoutUid && model?.byUid.get(layoutUid)?.name) || "(unknown layout)",
        objects,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const pad = BASE_PAD + (depthOffset + 1) * INDENT;
    return layoutGroups.map((lg) => {
      const key = `${fileUid ?? ""}:layoutObject:${lg.layoutUid}`;
      const autoOpen = refFiltering || layoutObjectFiltering || lg.objects.some((o) => o.uid === activeUid);
      const open = (autoOpen || openGroups.has(key)) && !collapsedGroups.has(key);
      return (
        <div key={key}>
          <div className="group-header clickable nested" style={{ paddingLeft: pad }} onClick={() => toggleGroup(key, open)}>
            <span className={`fchevron${open ? " open" : ""}`}>›</span>
            {lg.name} · {lg.objects.length}
          </div>
          {open && lg.objects.slice(0, GROUP_LIMIT).map((obj) => renderLeaf(obj, depthOffset + 2))}
          {open && lg.objects.length > GROUP_LIMIT && (
            <div className="node" style={{ color: "var(--text-dim)", paddingLeft: pad + INDENT }}>
              +{lg.objects.length - GROUP_LIMIT} more — narrow your search
            </div>
          )}
        </div>
      );
    });
  };

  /** A type group's fields split into base-table sub-groups (each collapsed by
   * default). A field's base table is its `parentUid`. `depthOffset` is the
   * parent type group's depth; sub-groups sit one level in and their leaves
   * one level further, like script folders. */
  const renderFieldsByBaseTable = (items: FmObject[], fileUid: string | null, depthOffset: number) => {
    const byTable = new Map<string, FmObject[]>();
    for (const field of items) {
      const tableKey = field.parentUid ?? "";
      const list = byTable.get(tableKey);
      if (list) list.push(field);
      else byTable.set(tableKey, [field]);
    }
    const tableGroups = [...byTable.entries()]
      .map(([parentUid, fields]) => ({
        parentUid,
        name: (parentUid && model?.byUid.get(parentUid)?.name) || "(no base table)",
        fields,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const pad = BASE_PAD + (depthOffset + 1) * INDENT;
    return tableGroups.map((tg) => {
      const key = `${fileUid ?? ""}:field:${tg.parentUid}`;
      const autoOpen = fieldFiltering || refFiltering || tg.fields.some(f => f.uid === activeUid);
      const open = (autoOpen || openGroups.has(key)) && !collapsedGroups.has(key);
      return (
        <div key={key}>
          <div className="group-header clickable nested" style={{ paddingLeft: pad }} onClick={() => toggleGroup(key, open)}>
            <span className={`fchevron${open ? " open" : ""}`}>›</span>
            {tg.name} · {tg.fields.length}
          </div>
          {open && tg.fields.slice(0, GROUP_LIMIT).map((obj) => renderLeaf(obj, depthOffset + 2))}
          {open && tg.fields.length > GROUP_LIMIT && (
            <div className="node" style={{ color: "var(--text-dim)", paddingLeft: pad + INDENT }}>
              +{tg.fields.length - GROUP_LIMIT} more — narrow your search
            </div>
          )}
        </div>
      );
    });
  };

  /** Render one type group. `depthOffset` indents it when nested under a file.
   * With a single type picked in the rail the type header is redundant, so it's
   * dropped and the group's contents move up one level (always expanded). */
  const renderGroup = (group: NavGroup, fileUid: string | null, depthOffset: number) => {
    const { type, items } = group;
    const realCount = items.filter((o) => !o.isSeparator).length;
    const foldered = items.some((o) => o.folder);
    const key = `${fileUid ?? ""}:${type}`;
    const showHeader = typeFilter === "all";
    const autoOpen = refFiltering || items.some(o => o.uid === activeUid);
    const open = !showHeader || ((autoOpen || openGroups.has(key)) && !collapsedGroups.has(key));
    const pad = BASE_PAD + depthOffset * INDENT;
    // Depth the group's contents are laid out from (their parent's depth).
    const inner = showHeader ? depthOffset : depthOffset - 1;
    return (
      <div key={key}>
        {showHeader && (
          <div
            className={`group-header clickable${depthOffset > 0 ? " nested" : ""}`}
            style={{ paddingLeft: pad }}
            onClick={() => toggleGroup(key, open)}
            data-nav-kind="type"
            data-type-key={key}
            data-open={open ? "1" : "0"}
          >
            <span className={`fchevron${open ? " open" : ""}`}>›</span>
            {OBJECT_TYPE_META[type].plural} · {realCount}
          </div>
        )}
        {open &&
          (type === "field"
            ? renderFieldsByBaseTable(items, fileUid, inner)
            : type === "layoutObject"
              ? renderLayoutObjectsByLayout(items, fileUid, inner)
              : foldered
                ? renderTree(buildTree(items), inner + 1)
                : items.slice(0, GROUP_LIMIT).map((obj) => renderLeaf(obj, inner + 1)))}
        {open && !foldered && type !== "field" && type !== "layoutObject" && items.length > GROUP_LIMIT && (
          <div className="node" style={{ color: "var(--text-dim)", paddingLeft: BASE_PAD + (inner + 1) * INDENT }}>
            +{items.length - GROUP_LIMIT} more — narrow your search
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="navigator">
      <div className="controls">
        <div className="nav-title-row">
          <span className="nav-title">{typeFilter === "all" ? "All objects" : OBJECT_TYPE_META[typeFilter].plural}</span>
          <span className="nav-title-count">
            {shownCount === totalCount
              ? totalCount.toLocaleString()
              : `${shownCount.toLocaleString()} of ${totalCount.toLocaleString()}`}
          </span>
          <FilterMenu model={model} base={baseObjects} type={typeFilter} filters={filters} />
        </div>
      </div>

      <div className="nav-scroll">
        <div className="results" ref={scrollRef}>
          {pinnedFile && (
            <div className="floating-header" ref={floatRef}>
              <div
                className="file-header"
                onClick={() => toggleFile(pinnedFile.uid)}
                title={pinnedFile.name}
              >
                <span className={`fchevron${!collapsedFiles.has(pinnedFile.uid) ? " open" : ""}`}>›</span>
                <FileIcon />
                <span className="ellipsis">{pinnedFile.name}</span>
              </div>
              {pinnedType && pinned.typeKey && (() => {
                const ptKey = pinned.typeKey!;
                const ptAutoOpen = refFiltering || typeFilter !== "all" || (pinnedType.items.some(o => o.uid === activeUid));
                const ptOpen = (ptAutoOpen || openGroups.has(ptKey)) && !collapsedGroups.has(ptKey);
                return (
                <div
                  className="group-header clickable nested"
                  style={{ paddingLeft: BASE_PAD + INDENT }}
                  onClick={() => toggleGroup(ptKey, ptOpen)}
                >
                  <span className={`fchevron${ptOpen ? " open" : ""}`}>›</span>
                  {OBJECT_TYPE_META[pinnedType.type].plural} ·{" "}
                  {pinnedType.items.filter((o) => !o.isSeparator).length}
                </div>
                );
              })()}
            </div>
          )}
          {sections.length === 0 && <div className="group-header">No matches</div>}
          {sections.map((section) => {
            if (!section.file) {
              return section.groups.map((g) => renderGroup(g, null, 0));
            }
            const f = section.file;
            // An explicit collapse always wins, even while filtering —
            // mirrors how collapsedGroups overrides a group's auto-open. Files are
            // open by default (empty set), so this still auto-expands everything.
            const open = !collapsedFiles.has(f.uid);
            return (
              <div key={f.uid}>
                <div
                  className="file-header"
                  onClick={() => toggleFile(f.uid)}
                  title={f.name}
                  data-nav-kind="file"
                  data-file-uid={f.uid}
                >
                  <span className={`fchevron${open ? " open" : ""}`}>›</span>
                  <FileIcon />
                  <span className="ellipsis">{f.name}</span>
                </div>
                {open && section.fileNode && renderLeaf(section.fileNode, 1)}
                {open && section.groups.map((g) => renderGroup(g, f.uid, 1))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg
      className="folder-icon"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    >
      <path d="M1.9 4.1c0-.5.4-.9.9-.9h3c.3 0 .6.1.8.4l.7.9h6c.5 0 .9.4.9.9v6.2c0 .5-.4.9-.9.9H2.8c-.5 0-.9-.4-.9-.9z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      className="file-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    >
      <path d="M9 1.8H4.2c-.6 0-1 .4-1 1v10.4c0 .6.4 1 1 1h7.6c.6 0 1-.4 1-1V5.6z" />
      <path d="M9 1.8v3.3c0 .3.2.5.5.5h3.3" />
    </svg>
  );
}

interface TreeNode {
  name: string;
  /** Full folder path, used as the collapse key. */
  path: string;
  /** Subfolders and leaf objects, interleaved in document order. */
  children: (TreeNode | FmObject)[];
  folderMap: Map<string, TreeNode>;
}

function isTreeNode(child: TreeNode | FmObject): child is TreeNode {
  return (child as TreeNode).folderMap !== undefined;
}

/** Build a nested folder tree from items carrying " / "-joined folder paths. */
function buildTree(items: FmObject[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], folderMap: new Map() };
  for (const obj of items) {
    const segments = obj.folder ? obj.folder.split(" / ") : [];
    let node = root;
    let acc = "";
    for (const seg of segments) {
      acc = acc ? `${acc} / ${seg}` : seg;
      let child = node.folderMap.get(seg);
      if (!child) {
        child = { name: seg, path: acc, children: [], folderMap: new Map() };
        node.folderMap.set(seg, child);
        node.children.push(child);
      }
      node = child;
    }
    node.children.push(obj);
  }
  return root;
}

/** Drop leading/trailing separator leaves and collapse consecutive ones. */
function trimSeparators(children: (TreeNode | FmObject)[]): (TreeNode | FmObject)[] {
  const isSep = (c: TreeNode | FmObject) => !isTreeNode(c) && c.isSeparator === true;
  const out: (TreeNode | FmObject)[] = [];
  for (const child of children) {
    if (isSep(child)) {
      const prev = out[out.length - 1];
      if (out.length === 0 || (prev && isSep(prev))) continue;
    }
    out.push(child);
  }
  while (out.length && isSep(out[out.length - 1]!)) out.pop();
  return out;
}

function groupByType(items: FmObject[]): NavGroup[] {
  const order = Object.keys(OBJECT_TYPE_META) as ObjectType[];
  const buckets = new Map<ObjectType, FmObject[]>();
  for (const obj of items) {
    const list = buckets.get(obj.type);
    if (list) list.push(obj);
    else buckets.set(obj.type, [obj]);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      // Objects with a catalog order (scripts) sort in document order; the
      // rest fall back to alphabetical by name.
      const ao = a.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
    });
  }
  return order.filter((t) => buckets.has(t)).map((t) => ({ type: t, items: buckets.get(t) ?? [] }));
}
