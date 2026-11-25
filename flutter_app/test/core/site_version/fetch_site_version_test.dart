import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pet_profile_app/core/site_version/fetch_site_version.dart';
import 'package:pet_profile_app/core/site_version/site_version_info.dart';

void main() {
  test('loadSiteVersionFromWeb returns parsed version on 200', () async {
    final client = MockClient((request) async {
      expect(request.url.path, '/version.json');
      expect(request.url.queryParameters['_'], isNotEmpty);
      return http.Response('{"version":"1.2.3","build":"abc1234"}', 200);
    });
    final info = await loadSiteVersionFromWeb(client: client);
    expect(info.version, '1.2.3');
    expect(info.build, 'abc1234');
  });

  test('loadSiteVersionFromWeb returns empty on non-200', () async {
    final client = MockClient((_) async => http.Response('missing', 404));
    expect(
      await loadSiteVersionFromWeb(client: client),
      SiteVersionInfo.empty(),
    );
  });

  test('loadSiteVersionFromWeb returns empty on invalid JSON shape', () async {
    final client = MockClient((_) async => http.Response('"nope"', 200));
    expect(
      await loadSiteVersionFromWeb(client: client),
      SiteVersionInfo.empty(),
    );
  });

  test('siteVersionFromPayload returns empty for non-map', () {
    expect(siteVersionFromPayload(null), SiteVersionInfo.empty());
    expect(siteVersionFromPayload([]), SiteVersionInfo.empty());
  });
}
