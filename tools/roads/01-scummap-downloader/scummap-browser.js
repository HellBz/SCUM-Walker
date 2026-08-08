(() => {
    const hookedPrototypes = new WeakSet();
    let hookCount = 0;

    function hookPrototype(prototype, name) {
        if (!prototype || hookedPrototypes.has(prototype)) {
            return false;
        }

        const original = prototype._onCacheHit;

        if (typeof original !== "function") {
            return false;
        }

        prototype._onCacheHit = function(e, t, a, r) {
            console.group("[Leaflet Tile Cache Hit]");
            console.log("Class:", name);
            console.log("Cache document ID:", a?._id);
            console.log("Tile URL:", t);
            console.log("Cache document:", a);
            console.log("Tile element:", e);
            console.log("Layer instance:", this);
            console.groupEnd();

            if (a?._id && this?._db?.get) {
                this._db
                    .get(a._id)
                    .then(doc => {
                        console.log("[Leaflet Cache Document]", doc);
                    })
                    .catch(error => {
                        console.warn("[Leaflet Cache Document Error]", error);
                    });
            }

            if (a?._id && this?._db?.getAttachment) {
                this._db
                    .getAttachment(a._id, "tile")
                    .then(blob => {
                        const objectUrl = URL.createObjectURL(blob);

                        console.log("[Leaflet Cache Blob]", blob);
                        console.log("[Leaflet Cache Blob URL]", objectUrl);

                        window.__leafletTileCache ??= [];
                        window.__leafletTileCache.push({
                            id: a._id,
                            tileUrl: t,
                            blob,
                            objectUrl,
                            timestamp: a.timestamp ?? null,
                            document: a
                        });
                    })
                    .catch(error => {
                        console.warn("[Leaflet Cache Attachment Error]", error);
                    });
            }

            return original.call(this, e, t, a, r);
        };

        hookedPrototypes.add(prototype);
        hookCount++;

        console.log(`[Leaflet Cache Hook] Hooked: ${name}`);

        return true;
    }

    function inspectObject(object, path, visited, depth = 0) {
        if (
            !object ||
            (typeof object !== "object" && typeof object !== "function") ||
            visited.has(object) ||
            depth > 5
        ) {
            return;
        }

        visited.add(object);

        try {
            if (object.prototype) {
                hookPrototype(object.prototype, `${path}.prototype`);
            }

            hookPrototype(object, path);

            for (const key of Object.getOwnPropertyNames(object)) {
                if (
                    key === "caller" ||
                    key === "callee" ||
                    key === "arguments"
                ) {
                    continue;
                }

                let value;

                try {
                    value = object[key];
                } catch {
                    continue;
                }

                if (
                    value &&
                    (typeof value === "object" || typeof value === "function")
                ) {
                    inspectObject(
                        value,
                        `${path}.${key}`,
                        visited,
                        depth + 1
                    );
                }
            }
        } catch (error) {
            console.debug("[Leaflet Cache Hook] Inspection skipped:", path, error);
        }
    }

    if (typeof window.L === "undefined") {
        console.error("[Leaflet Cache Hook] Leaflet was not found as window.L.");
        return;
    }

    inspectObject(window.L, "L", new WeakSet());

    if (hookCount === 0) {
        console.warn(
            "[Leaflet Cache Hook] No _onCacheHit method was found. The plugin may be bundled in a private module."
        );
        return;
    }

    window.__leafletTileCache ??= [];

    window.getLeafletTileCache = function() {
        console.table(
            window.__leafletTileCache.map(entry => ({
                id: entry.id,
                tileUrl: entry.tileUrl,
                objectUrl: entry.objectUrl,
                timestamp: entry.timestamp
            }))
        );

        return window.__leafletTileCache;
    };

    window.openLeafletTile = function(id) {
        const entry = window.__leafletTileCache.find(item => item.id === id);

        if (!entry) {
            console.error("[Leaflet Cache Hook] Tile ID not found:", id);
            return null;
        }

        window.open(entry.objectUrl, "_blank");

        return entry;
    };

    window.downloadLeafletTile = function(id, filename = `${id}.png`) {
        const entry = window.__leafletTileCache.find(item => item.id === id);

        if (!entry) {
            console.error("[Leaflet Cache Hook] Tile ID not found:", id);
            return null;
        }

        const link = document.createElement("a");
        link.href = entry.objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();

        return entry;
    };

    console.log(
        `[Leaflet Cache Hook] Ready. Hooked ${hookCount} prototype(s). Move or zoom the map to trigger tile requests.`
    );
    console.log("Available commands:");
    console.log("getLeafletTileCache()");
    console.log('openLeafletTile("db01411d-3481-4742-8526-aad5a308d3e0")');
    console.log('downloadLeafletTile("db01411d-3481-4742-8526-aad5a308d3e0")');
})();