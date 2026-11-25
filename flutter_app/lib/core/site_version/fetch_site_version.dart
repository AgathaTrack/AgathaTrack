import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb, visibleForTesting;
import 'package:http/http.dart' as http;

import 'site_version_info.dart';

SiteVersionInfo siteVersionFromPayload(Object? decoded) {
  if (decoded is! Map<String, dynamic>) {
    return SiteVersionInfo.empty();
  }
  return SiteVersionInfo(
    version: decoded['version']?.toString() ?? '',
    build: decoded['build']?.toString() ?? '',
  );
}

/// HTTP load path used on web; [client] is required so tests can inject [MockClient].
@visibleForTesting
Future<SiteVersionInfo> loadSiteVersionFromWeb({
  required http.Client client,
}) async {
  final uri = Uri.parse('/version.json').replace(
    queryParameters: {'_': DateTime.now().millisecondsSinceEpoch.toString()},
  );
  try {
    final response = await client.get(uri);
    if (response.statusCode != 200) {
      return SiteVersionInfo.empty();
    }
    return siteVersionFromPayload(json.decode(response.body));
  } catch (_) {
    return SiteVersionInfo.empty();
  }
}

/// Loads [SiteVersionInfo] from the site-root `version.json` (not under `/backend`).
Future<SiteVersionInfo> fetchSiteVersion({http.Client? client}) async {
  if (!kIsWeb) {
    return SiteVersionInfo.empty();
  }
  final httpClient = client ?? http.Client();
  try {
    return await loadSiteVersionFromWeb(client: httpClient);
  } finally {
    if (client == null) {
      httpClient.close();
    }
  }
}
