import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/about/presentation/widgets/about_version_label.dart';
import 'package:pet_profile_app/core/site_version/site_version_info.dart';
import 'package:pet_profile_app/l10n/app_localizations_en.dart';

void main() {
  test('formatAboutVersionLine shows stamped version on web payload', () {
    final l10n = AppLocalizationsEn();
    final line = formatAboutVersionLine(
      l10n,
      const SiteVersionInfo(version: '1.2.3', build: 'c7e6cc1'),
    );
    expect(line, 'Version 1.2.3 (c7e6cc1)');
  });

  test('formatAboutVersionLine falls back when empty', () {
    final l10n = AppLocalizationsEn();
    expect(
      formatAboutVersionLine(l10n, SiteVersionInfo.empty()),
      l10n.appVersionUnavailable,
    );
  });
}
