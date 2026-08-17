// Shared area fixture for the test suites.
//
// src/areas.js ships only generic URGENT + GENERAL defaults, so any test that
// exercises project areas has to declare them. Require this module BEFORE
// src/sync-helpers.js so the config is in place before the first read.
'use strict';

process.env.TASKMAXXING_AREAS = JSON.stringify([
  { key: 'URGENT', file: 'TASKS-URGENT.md', morgenLabel: 'Urgent', notionLabel: '01 URGENT' },
  { key: 'GENERAL', file: 'TASKS-GENERAL.md', morgenLabel: 'General', notionLabel: '02 GENERAL' },
  { key: 'PROJECT-A', file: 'TASKS-PROJECT-A.md', morgenLabel: 'Project-A', notionLabel: '03 PROJECT-A' },
  { key: 'PROJECT-B', file: 'TASKS-PROJECT-B.md', morgenLabel: 'Project-B', notionLabel: '04 PROJECT-B' },
  { key: 'PROJECT-C', file: 'TASKS-PROJECT-C.md', morgenLabel: 'Project-C', notionLabel: '05 PROJECT-C' },
  {
    key: 'NESTED-CONTENT',
    file: 'NESTED/content/TASKS-NESTED-content.md',
    morgenLabel: 'Nested-Content',
    notionLabel: '06 NESTED · content',
    pathPrefix: 'NESTED/content/',
    // Query-only parent hub: no inline tasks in practice, but writable and
    // resolves here, matching the previous hardcoded behaviour.
    aliasFiles: ['NESTED/TASKS-NESTED.md'],
  },
  {
    key: 'NESTED-BUILD',
    file: 'NESTED/misc-building/TASKS-NESTED-misc-building.md',
    morgenLabel: 'Nested-Building',
    notionLabel: '07 NESTED · misc-building',
    pathPrefix: 'NESTED/misc-building/',
  },
  {
    key: 'FUTURE-SCHEDULING',
    file: 'FUTURE-SCHEDULING/TASKS-FUTURE-SCHEDULING.md',
    morgenLabel: 'Future-Scheduling',
    notionLabel: '08 FUTURE-SCHEDULING',
    pathPrefix: 'FUTURE-SCHEDULING/',
  },
  { key: 'PROJECT-D', file: 'TASKS-PROJECT-D.md', morgenLabel: 'Project-D', notionLabel: '09 PROJECT-D' },
  { key: 'PROJECT-E', file: 'TASKS-PROJECT-E.md', morgenLabel: 'Project-E', notionLabel: '10 PROJECT-E' },
  { key: 'PROJECT-F', file: 'TASKS-PROJECT-F.md', morgenLabel: 'Project-F', notionLabel: '11 PROJECT-F' },
  { key: 'PROJECT-G', file: 'TASKS-PROJECT-G.md', morgenLabel: 'Project-G', notionLabel: '12 PROJECT-G' },
]);
