import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pet_profile_app/core/site_version/fetch_site_version.dart';
import 'package:pet_profile_app/core/site_version/site_version_info.dart';
import 'package:pet_profile_app/features/about/presentation/screens/about_screen.dart';
import 'package:pet_profile_app/features/about/presentation/widgets/about_version_label.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

void main() {
  testWidgets('AboutScreen loads stamped version via siteVersionLoader', (
    tester,
  ) async {
    final stamped = const SiteVersionInfo(version: '1.2.3', build: 'abc1234');
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => AboutScreen(
            siteVersionLoader: () => loadSiteVersionFromWeb(
              client: MockClient(
                (_) async =>
                    http.Response('{"version":"1.2.3","build":"abc1234"}', 200),
              ),
            ),
          ),
        ),
      ],
    );

    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: router,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
      ),
    );
    await tester.pumpAndSettle();

    final context = tester.element(find.byType(AboutScreen));
    final l10n = AppLocalizations.of(context)!;

    expect(find.text(l10n.aboutUs), findsOneWidget);
    expect(find.text(formatAboutVersionLine(l10n, stamped)), findsOneWidget);
  });

  testWidgets('AboutScreen shows unavailable when version.json missing', (
    tester,
  ) async {
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => AboutScreen(
            siteVersionLoader: () => loadSiteVersionFromWeb(
              client: MockClient((_) async => http.Response('', 404)),
            ),
          ),
        ),
      ],
    );

    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: router,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
      ),
    );
    await tester.pumpAndSettle();

    final context = tester.element(find.byType(AboutScreen));
    final l10n = AppLocalizations.of(context)!;

    expect(find.text(l10n.appVersionUnavailable), findsOneWidget);
  });
}
