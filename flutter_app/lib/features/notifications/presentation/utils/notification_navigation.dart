import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/router/shell_return_navigation.dart';
import '../../domain/entities/app_notification.dart';
import '../../domain/entities/notification_kind.dart';

void navigateToNotificationActions(BuildContext context) {
  context.go('/pc/events');
}

final _occurrenceDeepLinkPath = RegExp(
  r'^/pet/([^/]+)/events/([^/]+)/occurrences/([^/]+)$',
);

/// Opens an occurrence screen from an API [deepLink] path (push + in-app inbox).
bool _navigateOccurrenceDeepLink(BuildContext context, String deepLink) {
  final uri = Uri.parse(deepLink.startsWith('/') ? deepLink : '/$deepLink');
  final match = _occurrenceDeepLinkPath.firstMatch(uri.path);
  if (match == null) return false;

  final source = uri.queryParameters['source'] ?? 'notification';
  openOccurrenceScreen(
    context,
    petId: match.group(1)!,
    entryId: match.group(2)!,
    occurrenceId: match.group(3)!,
    source: source,
  );
  return true;
}

/// Navigates from a notification tap to the appropriate destination.
///
/// Care notifications with an occurrence open the Care date screen with
/// `occurrence_screen_opened{source: notification}`. Administrative types open
/// the pending-actions surface or other dedicated flows.
void navigateFromNotification(
  BuildContext context,
  AppNotification notification,
) {
  final wireType = notification.wireType;

  switch (wireType) {
    case 'shareInviteReceived':
      final code = notification.healthEntryId;
      if (code != null && code.isNotEmpty) {
        context.go('/invite/$code');
        return;
      }
      break;
    case 'shareInviteAccepted':
      final petId = notification.petId;
      if (petId != null && petId.isNotEmpty) {
        context.go('/pet/$petId/share');
        return;
      }
      break;
    case 'pendingFosterPlacementReceived':
    case 'pendingAdoptionPlacementReceived':
    case 'pendingCustodyTransferReceived':
    case 'fosterRequestReceived':
      context.go('/pending-actions');
      return;
  }

  final petId = notification.petId;
  final entryId = notification.healthEntryId;
  final occurrenceId = notification.healthOccurrenceId;

  if (petId != null && petId.isNotEmpty) {
    if (entryId != null &&
        entryId.isNotEmpty &&
        notification.kind != NotificationKind.administrative) {
      final deepLink = notification.deepLink;
      if (deepLink != null &&
          deepLink.isNotEmpty &&
          _navigateOccurrenceDeepLink(context, deepLink)) {
        return;
      }
      if (occurrenceId != null && occurrenceId.isNotEmpty) {
        openOccurrenceScreen(
          context,
          petId: petId,
          entryId: entryId,
          occurrenceId: occurrenceId,
          source: 'notification',
        );
        return;
      }
      openPetEventView(context, petId: petId, entryId: entryId);
      return;
    }
    context.push(
      petDetailLocation(petId, returnTo: currentShellLocation(context)),
    );
    return;
  }
}
