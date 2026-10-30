setTimeout(() => {
    process.stdout.write(JSON.stringify({ ok: true, embedded: 1, skipped: 0, removed: 0, durationMs: 50 }));
}, 50);
