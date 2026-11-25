import '../../../../l10n/app_localizations.dart';
import '../../../../core/site_version/site_version_info.dart';

String formatAboutVersionLine(AppLocalizations l10n, SiteVersionInfo info) {
  final version = info.version.trim();
  final build = info.build.trim();
  if (version.isEmpty || build.isEmpty) {
    return l10n.appVersionUnavailable;
  }
  return l10n.appAboutVersionLine(version, build);
}
