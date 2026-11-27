import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Context for §10.2 planned vet completion health-issue prompt (D-CIE-050).
class CarePlannedVetPromptContext {
  const CarePlannedVetPromptContext({
    required this.petId,
    required this.entryId,
    this.careSettingWire,
    this.carePlanningWire,
    this.healthIssueId,
    this.careFamily,
  });

  final String petId;
  final String entryId;
  final String? careSettingWire;
  final String? carePlanningWire;
  final String? healthIssueId;
  final String? careFamily;
}

typedef CarePlannedVetPromptHook =
    Future<void> Function(
      BuildContext context,
      WidgetRef ref,
      CarePlannedVetPromptContext contextData,
    );

/// Registered in app composition (`main.dart`); defaults to no-op.
final carePlannedVetPromptHookProvider = Provider<CarePlannedVetPromptHook>(
  (ref) => (_, __, ___) async {},
);