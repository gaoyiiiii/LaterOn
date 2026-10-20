// Mutations that must serialize with AI result application. Each reads the latest data.
function createLaterOnData({ queueItemWrite, normalizeUrl }) {
  const I = 'laterOnItems', P = 'laterOnProjects', C = 'laterOnCovers', O = 'laterOnOrder', CURRENT = 'laterOnCurrentItem';
  return async function mutate(message) {
    return queueItemWrite(async () => {
      const s = await chrome.storage.local.get([I,P,C,O,CURRENT]);
      let items = s[I] || [], projects = s[P] || [], covers = s[C] || {}, orders = s[O] || {};
      let write = {}, result = {};
      if (message.operation === 'project-update') {
        const old = projects.find(p => p.id === message.id);
        if (!old) throw new Error('projectMissing');
        const patch = {};
        for (const key of ['name','note','cover','coverPick','pinned','pinFrom','archived']) if (Object.hasOwn(message.patch || {}, key)) patch[key] = message.patch[key];
        if (Object.hasOwn(patch, 'name')) {
          patch.name = String(patch.name || '').trim();
          if (!patch.name || patch.name.length > 28 || projects.some(p => p.id !== old.id && p.name === patch.name)) throw new Error('invalidProjectName');
        }
        if (Object.hasOwn(patch, 'note')) {
          patch.note = String(patch.note || '').trim();
          if (!patch.note || patch.note.length > 2000) throw new Error('missingNotes');
        }
        projects = projects.map(p => {
          if (p.id !== old.id) return p;
          const next = { ...p, ...patch };
          if (patch.pinned === false) { delete next.pinned; delete next.pinFrom; }
          if (Array.isArray(patch.coverPick) && !patch.coverPick.length) delete next.coverPick;
          return next;
        });
        if (message.order) projects = orderProjects(projects, message.order);
        write[P] = projects;
      } else if (message.operation === 'project-order') {
        projects = orderProjects(projects, message.order || []); write[P] = projects;
      } else if (message.operation === 'project-delete') {
        const deleted = new Set(items.filter(i => i.projectId === message.id).map(i => i.id));
        projects = projects.filter(p => p.id !== message.id); items = items.filter(i => !deleted.has(i.id));
        covers = Object.fromEntries(Object.entries(covers).filter(([id]) => !deleted.has(id)));
        orders = Object.fromEntries(Object.entries(orders).filter(([id]) => id !== message.id).map(([id,list]) => [id, list.filter(v => !deleted.has(v))]));
        write = { [P]: projects, [I]: items, [C]: covers, [O]: orders };
        if (deleted.has(s[CURRENT])) write[CURRENT] = null;
      } else if (message.operation === 'wipe') {
        items = []; covers = {}; orders = {};
        write = { [I]: [], [C]: {}, [O]: {}, [CURRENT]: null, laterOnReadingPositions: {} };
      } else if (message.operation === 'import') {
        const payload = message.payload;
        if (!payload || !Array.isArray(payload.items) || !Array.isArray(payload.projects || [])) throw new Error('invalidBackup');
        const byUrl = new Map(items.map(i => [normalizeUrl(i.url), i])), ids = new Set(items.map(i => i.id));
        let skipped = 0;
        for (const entry of payload.items) {
          let valid = false;
          try { valid = entry && typeof entry.id === 'string' && !!entry.id && ['https:', 'http:'].includes(new URL(entry.url).protocol); } catch {}
          if (!valid) { skipped++; continue; }
          const url = normalizeUrl(entry.url);
          if (!byUrl.has(url) && !ids.has(entry.id)) { byUrl.set(url, entry); ids.add(entry.id); }
        }
        items = [...byUrl.values()];
        const projectIds = new Set(projects.map(p => p.id));
        for (const p of payload.projects || []) if (p && typeof p.id === 'string' && typeof p.name === 'string' && !projectIds.has(p.id)) { projects.push(p); projectIds.add(p.id); }
        // Preserve the existing backup merge policy, but read the latest data inside the shared queue.
        covers = { ...covers, ...(payload.covers || {}) }; orders = { ...orders, ...(payload.order || {}) };
        write = { [I]: items, [P]: projects, [C]: covers, [O]: orders }; result = { skipped };
      } else if (message.operation === 'migrate-items') {
        // Apply only legacy fields, preserving current assignment/status and newly saved items.
        const patches = new Map((message.items || []).map(i => [i.id, i]));
        items = items.map(item => {
          const p = patches.get(item.id); if (!p) return item;
          const next = { ...item };
          if (!item.status && p.status) next.status = p.status;
          if (!Number(item.doneAt) && Number(p.doneAt)) next.doneAt = p.doneAt;
          if (typeof item.image === 'string' && item.image.startsWith('data:') && p.image === `local://${item.id}`) next.image = p.image;
          return next;
        });
        covers = { ...(message.covers || {}), ...covers };
        write = { [I]: items, [C]: covers };
      } else throw new Error('invalidCommand');
      await chrome.storage.local.set(write);
      return { ok: true, items, projects, covers, orders, ...result };
    });
  };
  function orderProjects(projects, order) {
    const ids = [...new Set(order)], map = new Map(projects.map(p => [p.id,p]));
    return [...ids.map(id => map.get(id)).filter(Boolean), ...projects.filter(p => !ids.includes(p.id))];
  }
}
