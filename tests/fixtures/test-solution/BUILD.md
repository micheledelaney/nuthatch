# Test solution — build spec

Two files, **TEST_MAIN.fmp12** and **TEST_EXT.fmp12**, built in FileMaker 26. The expected parser output for this build is in [expected.json](expected.json); anything that deviates from this spec (a different formula, an extra field, a step in another position) changes what's expected, so build it exactly as written.

**Rule for broken scenarios:** anything named `DEL_…` gets created, referenced where stated, then deleted **last**, after everything that references it is in place.

**Appended items:** anything marked *(appended)* was added after the FM 26 / 22 / 21 exports were made. So far only `XML FM26/APPENDED TESTS/` contains them. Their expected output is [expected-appended.json](expected-appended.json), which the test adds on top of expected.json.

## Before you start (both files)

- Turn off default fields (File ▸ Manage ▸ Default Fields) before creating tables, so tables get no auto-added fields.
- Give **Admin** the password `admin`.

## TEST_EXT.fmp12 (the external file)

- Rename the default table → **E_Table**, its occurrence → **ETO_Main**, its layout → **EL_Layout**.
- Fields in E_Table: **e_ID** (Number), **e_Field** (Text). Place **e_Field** on EL_Layout.
- Script **ES_Script**: one step, `# ext`.
- Value list **EVL_List**: custom values `X¶Y`.
- **DEL_ES_Script** (one step `# del`) and **DEL_EL_Layout** (on ETO_Main): reference both from TEST_MAIN (S_Main steps 5 and 14), then delete them here.
- File Options: log in using **Guest** account.
- Accounts: **Admin** with password `admin` (as in "Before you start").

## TEST_MAIN — setup

- Rename the default table → **T_Main**, its occurrence → **TO_Main**, its layout → **L_Start**.
- Create a file **TEST_GONE.fmp12** with one table **G_Table**; it exists only long enough to add TO_ExtMissing, then delete it from disk before exporting.

## File Options & security switches

- Auto-login: account **autologin**; minimum version **22.0** (lowered to **18.0** only for the FileMaker 21 export, which can't open a file that requires 22).
- Turn on:
  - Allow stored credentials
  - Require iOS/iPadOS passcode
  - Show sign-in fields
- File Access:
  - Require full access to reference this file: on
  - All files must be on the same host: on
  - Authorize TEST_EXT
- File triggers:
  - OnFirstWindowOpen → **S_Trigger**
  - OnLastWindowClose → **DEL_Script_FileTrig**
- Switch to layout: **L_Start**; menu set: **MS_Main**

## External data sources

- **DS_Ext** → `file:TEST_EXT`
- **DS_Missing** → `file:TEST_GONE` (the file is deleted before export)
- **DS_VarPath** → `$$path`
- **DEL_DS** → `file:TEST_EXT`; use it in TO_DelDS, S_Main step 6 and VL_ExtDeleted, then delete it

## Tables

- **T_Main**, **T_Child**, **T_Grand**
- **T_Unused**: one field **u_Field** (Text); delete its auto-created occurrence, so nothing references it
- **DEL_Table**: rename its auto-created occurrence → **TO_Broken**, then delete the table

## Fields

**T_Child:** c_ID (Number), c_ParentID (Number), c_Name (Text), **DEL_Field2** (Text; used by VL_DelField and c_DelField), **DEL_Field3** (Text), **DEL_Field5** (Text; used by c_Fallback, the L_Calcs objects and M_Custom item 8) *(appended)*.
**T_Grand:** g_ChildID (Number), g_Val (Number).

**T_Main, general:**
- **f_ID** (Number), plain
- **f_Text** (Text): field comment `Main text field`
- **f_Unused** (Text): never referenced
- **f_TableViewOnly** (Text): see L_TableView
- **g_Global** (Text): global storage
- **f_Rep** (Text): 5 repetitions
- **f_Indexed** (Text): index All, language German
- **DEL_Field** (Text): no longer used by anything (c_DelField reads DEL_Field2 instead); still delete it with the others
- **DEL_Field4** (Text): see L_Start

**T_Main, validation:**
- **f_ValAll** (Number), all of:
  - not empty, unique, member of VL_Custom (FileMaker allows unique or existing, not both; existing is on f_ValMsgCalc)
  - range 1–100, max 10 characters
  - strict numeric only
  - validate by calc `f_ValAll > 0`
  - custom message `Bad value`
  - validate Always, user can't override
- **f_ValDate** (Date): strict 4-digit year only (defaults otherwise)
- **f_ValTime** (Time): strict time of day only (defaults otherwise)
- **f_ValCalcOff** (Text): validation calc `f_Text = "x"`, then untick "Validated by calculation" (no other requirement)
- **f_ValMsgCalc** (Text): not empty, existing value, custom message as a calculation `"Bad: " & f_Text`
- **f_ValMsgOff** (Text): not empty, custom message calc `f_Const`, then untick the custom message
- **f_ValDelVL** (Text): member of **DEL_VL_Val** (custom `1¶2`); delete the value list

**T_Main, containers:** f_Cont and f_ContOpen store externally in the file's default base directory **TEST_MAIN/** (Manage ▸ Containers). Only open storage takes its own folder path.
- **f_Cont**: max 500 KB, stored externally (secure)
- **f_ContOpen**: stored externally (open), folder path calculation `"TestDir/"`
- **f_ContInFile**: stored in the file *(appended)*

**T_Main, auto-enter:**
- **f_Serial** (Number): serial number, increment 2, on commit
- **f_Created** (Timestamp): creation timestamp
- **f_Const** (Text): data `ABC`
- **f_LastVisited** (Text): value from last visited record
- **f_AECalc** (Text): calc `f_Text`, prohibit modification, don't replace existing
- **f_AECalcOff** (Text): auto-enter calc `f_Const`, then untick it
- **f_Lookup** (Text): looked-up value from TO_Child::c_Name
- **f_LookupOff** (Text): lookup from TO_Child::c_ID, then untick it

**T_Main, calculations** (context TO_Main for all):
- **c_Stored**: `f_Text & "!"`
- **c_Unstored**: `Get ( CurrentDate )`, unstored
- **c_Deep**: `TO_Grand::g_Val` (two relationship hops)
- **c_UsesCF**: `CF_Used ( 1 )`
- **c_Global**: `$$GLOBAL_A`
- **c_Ext**: `TO_Ext::e_Field`
- **c_DelCF**: `DEL_CF ( 1 )`; delete the function → `<Function Missing>`
- **c_DelField**: `TO_Child::DEL_Field2`; deleting DEL_Field2 → `TO_Child::<Field Missing>`. Note: FileMaker won't delete a field while a calculation in the same table uses it, so the deleted field has to be in another table (T_Child). Reading through a relationship makes c_DelField unstored.
- **c_DelTO**: `DEL_TO::c_Name`; delete the occurrence → `<Table Missing>`
- **c_Fallback** (Text) *(appended)*: `/* TO_Main::f_Text */ "TO_Main::f_ID" & f_Text & CF_Used ( 1 ) & $$GLOBAL_A & $$two words & TO_Ext::e_Field & TO_Child::DEL_Field5`. Deleting DEL_Field5 empties its chunk list, so its references can only be read from the formula text: a comment, a string literal, a bare same-table field, a custom function, globals (one with a space), an external field by name, and the deleted field. Reading through relationships makes it unstored.

**T_Main, summaries:**
- **s_Total**: running total of f_ValAll, restart for each sorted group, when sorted by f_ValAll
- **s_List**: list of f_Text

## Table occurrences

- **TO_Main** (T_Main), **TO_Child** (T_Child), **TO_Grand** (T_Grand)
- **TO_Ext**: E_Table via DS_Ext
- **TO_ExtMissing**: G_Table via DS_Missing
- **TO_VarPath**: E_Table via DS_VarPath. First run a script that sets `$$path` to `"file:TEST_EXT"` so the table can be picked; use **S_SetPath** below.
- **TO_DelDS**: E_Table via DEL_DS
- **TO_Broken**: on DEL_Table
- **TO_Unused**: T_Child, in no relationship
- **TO_Collapsed**: T_Main, collapsed box, custom color
- **TO_Cartesian**: T_Child
- **DEL_TO**, **DEL_TO3**: T_Child; reference them, then delete them

## Relationships

- **R1**: TO_Main::f_ID = TO_Child::c_ParentID. On the TO_Child side: allow creation, delete related records, sort by c_Name.
- **R2**: TO_Child::c_ID = TO_Grand::g_ChildID
- **R3**: TO_Main::f_ID = TO_Ext::e_ID
- **R4**: TO_Main::f_ValAll to TO_Collapsed::f_ValAll with five predicates: ≠ < ≤ > ≥
- **R5**: TO_Main::f_ID × TO_Cartesian::c_ID
- **R6**: TO_Main::f_ID = DEL_TO::c_ParentID (goes away with DEL_TO)
- **R7**: TO_Main::f_ID = DEL_TO3::c_ParentID (goes away with DEL_TO3)

## Value lists

- **VL_Custom**: `A¶B¶-¶C`
- **VL_Field**: TO_Child::c_Name, sorted
- **VL_Field2nd**: TO_Child::c_Name, also display TO_Child::c_ID
- **VL_Field2ndOff**: TO_Child::c_Name; pick second field TO_Child::c_ID, then untick "Also display"
- **VL_Related**: TO_Child::c_Name, include only related values from TO_Main
- **VL_RelatedOff**: TO_Child::c_Name; pick TO_Main for related values, then turn the option off
- **VL_External**: EVL_List from DS_Ext
- **VL_ExtDeleted**: EVL_List from DEL_DS
- **VL_DelField**: TO_Child::DEL_Field2; delete the field
- **VL_Unused**: custom `z`
- **VL_SecondOnly** *(appended)*: TO_Child::c_Name, also display TO_Child::c_ID, show values only from the second field
- **DEL_VL_Val**, **DEL_VL_Fmt**: custom `1¶2`; see f_ValDelVL / L_Start

## Custom functions

- **CF_Used** (x): `x * 2`
- **CF_CallsCF** (x): `CF_Used ( x ) + 1`
- **CF_Recursive** (n): `If ( n ≤ 0 ; 0 ; CF_Recursive ( n - 1 ) )`
- **CF_Empty**: no parameters, no body
- **CF_Unused** (x): `x`
- **DEL_CF** (x): `x`; see c_DelCF

## Scripts

**Folders:** folder **Test** holds S_Main, then a separator, then S_Trigger, S_Unused, S_OnlyDisabled, S_FullAccess, S_Hidden and S_SetPath. Subfolder **Test / Sub** holds S_Sub and S_Callback.

**Script list:**
- **S_Sub**: `Exit Script [ Get ( ScriptParameter ) ]`
- **S_Callback**, **S_Trigger**, **S_Unused**: one step `# x`
- **S_OnlyDisabled**: one step `# x`; referenced only by a disabled step
- **S_FullAccess**: `# x`, run with full access
- **S_Hidden**: `# x`, not in the Scripts menu
- **S_SetPath**: `Set Variable [ $$path ; "file:TEST_EXT" ]`
- **DEL_Script**, **DEL_Script_FileTrig**, **DEL_Script_LayTrig**, **DEL_Script_ObjTrig**, **DEL_Script_Menu**: `# x`; reference them, then delete them

**S_Main, steps (in exactly this order):**
1. `# start`
2. Perform Script [ S_Sub ; Parameter: `TO_Main::f_ID` ]
3. Perform Script [ DEL_Script ]
4. Perform Script [ ES_Script from file DS_Ext ]
5. Perform Script [ DEL_ES_Script from file DS_Ext ]
6. Perform Script [ ES_Script from file DEL_DS ]
7. Perform Script on Server with Callback [ S_Sub ; callback S_Callback ]
8. Perform Script [ S_OnlyDisabled ]: **disable this step**
9. Go to Layout [ L_Detail ]
10. Go to Layout [ DEL_Layout ]
11. Go to Layout [ by name: `"L_" & "Detail"` ]
12. Go to Related Record [ from TO_Child ; using L_Child ]
13. Go to Related Record [ from TO_Ext ; use external table's layouts ; EL_Layout ]
14. Go to Related Record [ from TO_Ext ; use external table's layouts ; DEL_EL_Layout ]
15. Go to Related Record [ from DEL_TO ; current layout ]
16. Set Field [ TO_Main::f_Text ; `"x"` ]
17. Set Field [ DEL_TO3::DEL_Field3 ; `"y"` ]: later delete the field **and** DEL_TO3
18. Set Variable [ $$GLOBAL_A ; `1` ]
19. Set Variable [ $$ONLY_SET ; `2` ]
20. Set Variable [ $local ; `3` ]: **set a debugger breakpoint on this step**
21. Insert from URL [ target $$RESULT ; `"https://example.com"` ]
22. Sort Records [ TO_Main::f_Text ascending, reorder by summary TO_Main::s_Total, blanks last ; no dialog ]
23. Import Records [ import.csv (3 columns) into TO_Main: column 1 → f_Text, columns 2–3 unmapped ; no dialog ]
24. Export Records [ export.csv ; TO_Main::f_Text, TO_Ext::e_Field ; no dialog ]
25. Perform Find [ restore: TO_Main::f_Text = `x` ]
26. Save Records as PDF [ out.pdf ; current record ; set any security option ]
27. Open File [ DS_Ext ]
28. Close File [ current file ]
29. Re-Login [ no dialog ]
30. Install Menu Set [ MS_Main ]
31. If [ `$local = 3` ]
32. End If
33. Set Field [ TO_Main::f_Text ; `TO_Main::f_Text & TO_Main::f_ID` ] *(appended)*: the value reads the step's own target
34. Set Variable [ $x ; `Evaluate ( "$$QUOTED" )` ] *(appended)*: a global named only inside a string
35. Insert Text [ select ; TO_Main::f_Text ; `Line 1¶Line 2` ] *(appended)*: two lines of text

(Earlier versions of this list had an `Else` at 32; no export ever had one.)

## Layouts

**Layout list:**
- **L_Start** (TO_Main), at the top level
- Folder **Layouts**:
  - **L_Calcs** (TO_Main) *(appended)*: first in the folder; see L_Calcs objects
  - **L_Detail** (TO_Main): every T_Main field except f_Unused, f_TableViewOnly and the DEL_ fields
  - a separator
  - **L_Hidden** (TO_Main): not in the layout menu
  - **L_Unused** (TO_Main)
  - **L_TableView** (TO_Main): place f_Text; switch to Table View, add f_TableViewOnly with "+"; then, in Layout mode, delete f_TableViewOnly from the form
  - **DEL_Layout** (TO_Main)
- Subfolder **Layouts / Sub**: **L_Child** (TO_Child), with TO_Child::c_Name

**L_Start setup:**
- Parts: header, body, sub-summary when sorted by TO_Main::f_Text, footer
- Menu set MS_Main
- Triggers:
  - OnLayoutEnter → S_Trigger
  - OnRecordLoad → DEL_Script_LayTrig

**L_Start objects: fields and text**
- TO_Main::f_Text field:
  - drop-down VL_Custom
  - placeholder `"Enter " & TO_Main::f_ID`
  - tooltip `TO_Main::f_Const`
  - hide when `IsEmpty ( TO_Main::f_Serial )`, also in Find mode
  - 2 conditional formats: `TO_Main::f_ValAll > 10` and `TO_Main::f_ValAll < 10`
  - accessibility label `"Main text"`
  - local styling (any fill color)
  - triggers: OnObjectEnter → S_Trigger; OnObjectModify → DEL_Script_ObjTrig
- Related field TO_Child::c_Name
- Field TO_Main::DEL_Field4, then delete that field
- A second TO_Main::f_Const field formatted as a pop-up with DEL_VL_Fmt; delete the value list
- Text object **obj_Named** containing `<<$$MERGE_VAR>>`
- A text object containing merge field `<<DEL_TO::c_Name>>`
- A text object `Off-layout`, placed entirely to the right of the layout area

**L_Start objects: buttons and controls**
- Button → Perform Script S_Main, parameter `"fromButton"`
- Button → single step Go to Layout L_Detail
- Button → Perform Script DEL_Script
- Grouped button (a text object `Go`) → Perform Script S_Main, parameter `TO_Main::f_ID`
- Button bar, 2 segments:
  - segment 1 → Perform Script S_Sub
  - segment 2 → Go to Layout L_Detail
- Popover containing TO_Main::f_Created
- Tab control, 2 panels:
  - panel 1: a portal on TO_Child containing TO_Child::c_Name
  - panel 2: TO_Main::f_Serial
- Slide control, 2 slides: TO_Main::f_Const, TO_Main::f_Lookup
- Portal on TO_Child, 5 rows, containing TO_Child::c_Name
- Portal on DEL_TO, empty
- Web viewer: `"https://example.com/?q=" & TO_Main::f_Text`
- Chart: x-axis TO_Main::f_Text, y-axis TO_Main::f_ValAll

**L_Calcs objects** *(appended)*: each named in the Inspector (Position ▸ Name). Each formula pairs a valid reference with DEL_Field5, so FileMaker leaves an empty chunk list and a `<Field Missing>` on the object itself.
- **obj_PortalFilter**: portal on TO_Child, filter `TO_Child::c_Name = TO_Main::f_Text and TO_Child::DEL_Field5 ≠ ""`
- **obj_ButtonParam**: button → Perform Script S_Sub, parameter `TO_Main::f_ID & TO_Child::DEL_Field5`
- **obj_ButtonStep**: button → single step Set Field [ TO_Main::f_Text ; `TO_Main::f_ID & TO_Child::DEL_Field5` ]
- **obj_TriggerParam**: field TO_Main::f_ID, OnObjectEnter → S_Trigger, parameter `TO_Main::f_Text & TO_Child::DEL_Field5`
- **obj_Label**: button labelled `Save` → Perform Script S_Sub
- **obj_ExtGTRR**: button → single step Go to Related Record [ from TO_Ext ; use external table's layouts ; EL_Layout ] (for the FM 22 export with TEST_EXT closed, see To do)

## Custom menus

- **M_Sub**: new menu, one item: command Paste
- **M_Custom**: based on Edit, install condition `Get ( SystemPlatform ) ≠ 3`, comment `Some comment` *(appended)*, with these items in order:
  1. command Copy
  2. `Run S_Main` → Perform Script S_Main
  3. submenu M_Sub
  4. separator
  5. `Shortcut item` → command Select All, shortcut ⌘⇧K
  6. `Conditional item` → command Undo, install condition `Get ( WindowMode ) = 0`
  7. `Deleted script item` → Perform Script DEL_Script_Menu
  8. *(appended)* command Copy, with:
     - title as a calculation `TO_Main::f_Text & TO_Child::DEL_Field5`
     - install condition `not IsEmpty ( TO_Main::f_Text ) and TO_Child::DEL_Field5 ≠ ""`
     - shortcut ⌘C overridden
- **MS_Main**: contains M_Custom; comment `Some comment` *(appended)*
- **MS_Unused**: new menu set, unchanged

## Privilege sets, accounts & extended privileges

**Privilege sets:**
- **PS_CustomRecords**: custom record access. T_Main row:
  - view limited `CF_Used ( 1 ) = 2`
  - edit limited `not IsEmpty ( f_Text )`
  - create yes
  - delete limited `f_Text ≠ "locked"`
  - custom field access: f_Text no access
  - Other tables: leave the defaults.
- **PS_CustomLayouts**:
  - L_Start modifiable (records modifiable)
  - L_Detail view only (records view only)
  - L_Hidden no access (records no access)
  - [Any New Layout] modifiable, and "Allow creation of new layouts" on (FileMaker only allows creating layouts when new layouts are modifiable)
- **PS_CustomScripts**: S_Main modifiable, S_Sub executable only, S_Unused no access
- **PS_CustomVL**: VL_Custom modifiable, VL_Field view only, VL_Unused no access
- **PS_Other**:
  - every Other privilege on, including Manage database and Manage custom menus
  - "Allow user to modify their own password" off
  - menu commands: Editing only
- **PS_Unused**: no accounts

**Accounts:**
- **Admin**: password `admin`, [Full Access]
- **acc_Active**: FileMaker, password `active`, PS_CustomRecords
- **acc_NoPwd**: FileMaker, empty password, active, PS_CustomLayouts
- **acc_Inactive**: FileMaker, password `x`, inactive, PS_CustomScripts
- **TestGroup**: External Server account for group `TestGroup` (FileMaker names an external account after its group), PS_CustomVL
- **autologin**: FileMaker, password `auto`, PS_Other
- **[Guest]**: leave as created (off)

**Extended privilege:** **xpTest** (keywords can't contain an underscore), description `Test keyword`, granted to PS_Other only.

## Exports to make (Save a Copy as XML)

Put them in `tests/fixtures/test-solution/exports/`. Before each export, close and reopen TEST_MAIN so `$$path` is empty.

There are two snapshots of the same build:

1. **Intact**: everything built and referenced, with all construction steps done (T_Unused's occurrence removed, f_TableViewOnly removed from the form, options unticked), but **before** any `DEL_…` deletion and while TEST_GONE.fmp12 is still on disk. Expected output: [expected-intact.json](expected-intact.json). The saved intact export (`TEST_MAIN__intact.xml`) was made before c_DelField was changed, so in it c_DelField still reads `DEL_Field` in T_Main; expected-intact.json matches that.
2. **Final**: after the `DEL_…` deletions, with TEST_GONE.fmp12 removed from disk. Expected output: [expected.json](expected.json).

| File | Snapshot | How |
|---|---|---|
| `TEST_MAIN_intact.xml`, `TEST_EXT_intact.xml` | intact | "Include details for analysis tools" on. Load them together, and TEST_MAIN on its own. |
| `TEST_MAIN.xml`, `TEST_EXT.xml` | final | "Include details for analysis tools" on. Load them together, and TEST_MAIN on its own. |
| `TEST_MAIN_noddr.xml` | final | Details off (tests the missing-DDR warning). |
| `TEST_MAIN_split/` | final | JSON options `{"split_catalogs": true}` |
| `TEST_MAIN_layouts_only.xml` | final | `{"catalogs_included": ["LayoutCatalog"]}` |
| `TEST_MAIN_binary.xml` | final | `{"standalone_binarydata": true}` |
| `fm21/…` | both | The same files from FileMaker 21 or earlier, if you have it. |
| `XML FM26/APPENDED TESTS/TEST_MAIN.xml`, `TEST_EXT.xml` | final, with the appended items | Details on. FM 26 only so far. TEST_MAIN in this export has minimum version **18.0**, not 22.0. |

New objects pick up the privilege sets' defaults; nothing was set for them by hand:
- PS_CustomRecords: every new T_Main field is view only.
- PS_CustomLayouts: L_Calcs is modifiable, with no access to records.
- PS_CustomVL: VL_SecondOnly has no access.

Also: note what SampleB's File Options ▸ "Log in using" shows. That settles the `Login type="-1"` label.

## Running the test

`npm test` (or `npm run test:watch`) runs [tests/test-solution.test.ts](../../test-solution.test.ts). It parses the exports in `XML FM26/`, `XML FM22/` and `XML FM21/` and checks them against the expected output. The same build must give the same model whichever FileMaker version exported it.

| Scenario | Exports | Expected output |
|---|---|---|
| FM26 intact: TEST_MAIN + TEST_EXT | `XML FM26/TEST_MAIN__intact.xml`, `XML FM26/TEST_EXT__intact.xml` | expected-intact.json |
| FM26 intact: TEST_MAIN alone | `XML FM26/TEST_MAIN__intact.xml` | expected-intact.json |
| FM26 final: TEST_MAIN + TEST_EXT | `XML FM26/TEST_MAIN.xml`, `XML FM26/TEST_EXT.xml` | expected.json |
| FM26 final: TEST_MAIN alone | `XML FM26/TEST_MAIN.xml` | expected.json |
| FM22 final: TEST_MAIN + TEST_EXT | `XML FM22/TEST_MAIN.xml`, `XML FM22/TEST_EXT.xml` (UTF-16) | expected.json |
| FM22 final: TEST_MAIN alone | `XML FM22/TEST_MAIN.xml` | expected.json |
| FM21 final: TEST_MAIN + TEST_EXT | `XML FM21/TEST_MAIN.xml` (UTF-16), `XML FM21/TEST_EXT.xml` | expected.json, with FM21 differences |
| FM21 final: TEST_MAIN alone | `XML FM21/TEST_MAIN.xml` | expected.json, with FM21 differences |
| FM26 appended: TEST_MAIN + TEST_EXT | `XML FM26/APPENDED TESTS/TEST_MAIN.xml`, `XML FM26/APPENDED TESTS/TEST_EXT.xml` | expected.json + expected-appended.json, with minimum version 18.0 |
| FM26 appended: TEST_MAIN alone | `XML FM26/APPENDED TESTS/TEST_MAIN.xml` | expected.json + expected-appended.json, with minimum version 18.0 |

FM21 differences (`FM21` in the test file): minimum version 18.0, and no "Manage database" / "Manage custom menus" privileges, which FileMaker 21 doesn't have. `XML FM21/TEST_EXT.xml` is currently a copy of the FM 26 export, not a FileMaker 21 one.

A layout object with an object name (Inspector ▸ Position ▸ Name) is referred to by it in the expected output, e.g. `MAIN:layoutObject:obj_PortalFilter`, so a single object's edges can be checked.

A scenario whose exports are missing is skipped. Checks tied to a pinned to-do run as expected failures (listed in `PINNED` in the test file), so a fix shows up as a failure there.

## To do

- **Parser: auto-login label** (pinned): the parser decides the File Options auto-login label by whether an account name is present, not by `<Login type>` (1 = named account, 0 = Guest, -1 = off). TEST_EXT (Guest) shows `Account “[Guest]”` instead of "Guest account", and a file with no automatic login (SampleB, `type="-1"`) shows "Guest account". Until fixed, the `EXT:file:TEST_EXT autoLogin` check fails. Still to decide: whether `-1` shows nothing or "Off".
- **Two broken edges for one deletion**: a deleted data source gives TO_DelDS two broken edges (data source and table), and VL_ExtDeleted two (value list and data source). The report card counts objects, so it's unaffected, but the object page and the browse list show "2 broken refs". Decide whether to keep both.
- **FM 22 export with TEST_EXT closed**: would confirm the closed-file shape the parser relies on (TO_Ext without its base table, step 13 without a layout id). It could also become a test scenario. With the appended build, obj_ExtGTRR also covers FM 22's deferred button targets.
- **Appended items**:
  - Export them from FM 22 and FM 21 too, and add those scenarios (same expected output; FM 21's install conditions and item titles use another XML shape).
  - Set TEST_MAIN's minimum version back to 22.0 before the next export, then drop `APPENDED` in the test file.
  - c_Fallback's comment can't be checked: `/* TO_Main::f_Text */` names a field the formula also reads bare. Change it to `/* TO_Main::f_Unused */` and add an absent edge to f_Unused.
  - Still to make: a copy of TEST_MAIN with encryption at rest, and `TEST_MAIN_noddr.xml` (listed above, never made).
- **Shortcut item** (pinned): no export has its command (Select All) or its shortcut (⌘⇧K); the item has only its title. Set both in TEST_MAIN and re-export. The pinned check `attributes: MAIN:customMenuItem:Shortcut item` then shows up as a failure; remove it from `PINNED`.
- **Themes** (left out of the tests for now): rename each file's default theme (**TH_Used** in TEST_MAIN, **TH_Ext** in TEST_EXT), import a second theme into TEST_MAIN as **TH_Unused** and apply it to nothing, and have every layout use its file's one theme. Then remove `"theme"` from `ignoredTypes` in both expected files and add the theme expectations back (see `todo` there).
