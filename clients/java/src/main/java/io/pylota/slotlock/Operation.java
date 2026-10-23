package io.pylota.slotlock;

import java.util.List;

/** One REST operation: its method, path, path parameters and query parameters. */
record Operation(String method, String path, List<String> pathParams, List<String> query) {}
