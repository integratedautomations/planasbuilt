# PlanAsBuilt roadmap (after M1–M9)

These decisions come from comparing PlanAsBuilt with Revu and System Surveyor (2026-10-19).

## M10 Controls and tools
- **Mouse**
  - Right-drag box-selects; a plain right-click opens a context menu.
  - Middle-drag pans while any tool is active.
  - Ctrl+drag copies the markup to the drop point.
    - Dragging from a stack copies one device.
    - The copy keeps the product and its settings, gets a new tag, and clears IP/MAC/serial/photos.
- **Hotkeys**
  - Hotkey editor with conflict detection and Restore Defaults.
  - Defaults follow Revu: R, L, E, C, Q, P, H, M, Shift+C/P/N/R/E, and Ctrl+Shift+V (paste in place).
- **Tool chest sidebar** (toolbox style)
  - Favorites bar, Recent tools (last 10), and a right-click menu showing favorites and recent tools.
- **Docking panels**
  - The Markups list, Properties, Pages/thumbnails and Tool chest can each dock left, right or bottom.
- **Markups list popup**
  - The user chooses which fields it shows.
- **Prefs:** hotkeys, layout, favorites and visible columns are saved per user on the server and follow the user to any device.

## M11 Catalog and BOM
- **Hierarchy:** Set > Device type > Product.
  - Cameras > IP Camera > Outdoor 8MP ColorVu
  - Fire > Smoke Detector > Potter photoelectric
- **Device type** has its own icon, its own extra fields and its own tag prefix (SD-01).
- **Product** has manufacturer, model, spec link, unit cost, labor hours, default field values and accessories.
  - Accessories are added to the count automatically.
- **Product dropdown:** each device type has a default product.
- **Catalog loading:** add products in the app, import them from Excel, or convert a Revu .btx tool set.
- **BOM:** quantities, cost and labor totals, exported to Excel and PDF.

## M12 Revisions and page tools
- **What makes a revision:** an Issue Revision snapshot (PDF plus markups plus device data, frozen) or a new PDF upload. A plain save is not a revision.
- **Diff tools:**
  - A markup change list (devices added, moved, deleted or with changed fields).
  - Automatic revision clouds around changes.
  - Side-by-side compare with synced pan and zoom.
  - A red/green visual overlay.
- **Page tools:** insert, extract, delete, replace and reorder pages. Markups follow their pages.
- **Print:** prints with markups, with a page range, fit or actual size, and a choice of layers.
- **Flatten:** export only (already built). Unflatten means importing the annotations.

## M13 Revu converter and legend
- **Import a Revu-marked plan:**
  - The importer lists each distinct Subject/icon, the user maps it once to a device type and product, and the mapping is saved.
  - Custom columns map to fields. This needs a sample file from the user.
  - **Findings from the sample (MU 58 South Parker Dr, 813 annotations, no custom columns):**
    - Devices are Revu *groups*. A parent Rectangle has children linked by /IRT + /RT /Group: rectangles, ellipses, a 1-letter FreeText ("S", "G", "MD") and a label FreeText ("SD-1", "OCAM-1", "SPK-1", "WC-16").
    - Subjects are mostly generic ("Rectangle", "Text Box"). Only a few carry meaning ("Door Strike", "Glass Break Sensor", "Data Jack").
    - Layers (/OC) carry the system: Burglar Alarm, Cameras, Fire, Aceess, Intercom, Paging, Data.
    - Map each group into one device. The key is the layer plus the label prefix (SD, OCAM, SPK, GB, DC, MD, WS, AP, TDJ, KP, CO, ES, LD, HD, SIPH, M15, ICM…). The group's bounding box gives position and size.
    - Labels repeat (SD-1 ×14), so the number is probably a type code, not a unique tag.
- **Count and legend:**
  - A legend table placed on the sheet that updates live.
  - Its scope is the sheet, the whole set or one area.
  - It is included in PDF exports.

## Later / undecided
- System Surveyor extras: camera resolution check (pixels per foot), maintenance dates, photo tour report, sharing with customers and subcontractors.

## M14 UI polish, settings, users and invites (decided 2026-10-20)
- **Less clutter:**
  - Properties opens only when something is selected. Areas and Compare start closed.
  - PDF, Revisions, Print and Hotkeys move into one ⋯ menu.
  - Tool chest groups start collapsed, except Favorites and Recent.
- **Density:** Compact on desktop, Comfortable on touch, chosen automatically and overridable.
- **Buttons:** 28/36/44px sizes. Primary is filled blue, secondary is outlined, destructive is red-outlined (a status color, not the brand red). Every icon button gets a tooltip that includes its hotkey.
- **Settings page tabs:**
  - Personal: theme, density, hotkeys, tool chest, overlap prompt, notifications.
  - Company (admin): name, logo and address for reports, report defaults, tag format, statuses.
  - Storage and backups (admin).
- **Users page:**
  - A table of name, email, role, projects, last active and status, with a side drawer for editing.
  - Deactivating a user keeps their name on markups they made.
  - Each project gets a Members tab.
- **Invites and resets:** links valid for 7 days. For now the admin copies the link; SMTP sending can be added in Settings later.
- **Storage:** files stay on the VPS disk for now, with a setting to switch to S3-compatible storage (Cloudflare R2). The page shows storage use per project, photo size limits and revision retention.

## M15 Collaboration and visibility
- **Notifications:** an in-app bell, email (instant or daily digest) and Web Push to phones with the app installed. Each user chooses per event type.
  - **Events:** mention, assignment, status change, new revision, comment reply, a failed sync, an accepted invite.
- **Comments and @mentions** on markups (Revu-style replies).
- **Project dashboard:** counts by status, % complete, recent activity.
- **Ctrl+K search:** tags, IPs, serials, sheets and commands.
- **Customer share link:** a read-only view or report link that can expire or be revoked.
