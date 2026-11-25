import 'package:flutter/material.dart';

import '../../../../core/widgets/app_logo_title.dart';
import '../../../../core/widgets/branded_logo.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../../core/site_version/fetch_site_version.dart';
import '../../../../core/site_version/site_version_info.dart';
import '../widgets/about_version_label.dart';

class AboutScreen extends StatefulWidget {
  const AboutScreen({super.key, this.initialSiteVersion});

  /// Test-only override; production leaves this null and loads `/version.json` on web.
  final SiteVersionInfo? initialSiteVersion;

  @override
  State<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends State<AboutScreen> {
  late Future<SiteVersionInfo> _versionFuture;

  @override
  void initState() {
    super.initState();
    _versionFuture = widget.initialSiteVersion != null
        ? Future.value(widget.initialSiteVersion!)
        : fetchSiteVersion();
  }

  Widget _buildLogo({required double size}) {
    return BrandedLogo(size: size, useJpg: true, clipOval: true);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(title: AppLogoTitle(title: l10n.aboutUs)),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 500),
            child: Column(
              children: [
                const SizedBox(height: 16),
                _buildLogo(size: 120),
                const SizedBox(height: 20),
                Text(
                  l10n.appTitle,
                  style: theme.textTheme.headlineLarge?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 20),
                Text(
                  l10n.appTagline,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: theme.colorScheme.onSurface,
                    height: 1.4,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 12),
                Text(
                  l10n.appDescription,
                  style: theme.textTheme.bodyLarge?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    height: 1.5,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),
                FutureBuilder<SiteVersionInfo>(
                  future: _versionFuture,
                  builder: (context, snapshot) {
                    final info = snapshot.data ?? SiteVersionInfo.empty();
                    final line = formatAboutVersionLine(l10n, info);
                    return Text(
                      line,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    );
                  },
                ),
                const SizedBox(height: 24),
              ],
            ),
          ),
        ),
      ),
    );
  }
}