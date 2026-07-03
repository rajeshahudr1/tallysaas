import 'package:geolocator/geolocator.dart';

/// Thin wrapper around geolocator that handles the service + runtime-permission
/// flow and returns the current GPS position. Throws a short, user-friendly
/// String on any failure so callers can surface it in a SnackBar.
class LocationHelper {
  static Future<Position> current() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw 'Location (GPS) is off. Please turn it on and try again.';
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied) {
      throw 'Location permission denied. Allow it to check in.';
    }
    if (perm == LocationPermission.deniedForever) {
      throw 'Location permission is permanently denied. Enable it in Settings.';
    }
    return Geolocator.getCurrentPosition(
      desiredAccuracy: LocationAccuracy.high,
      timeLimit: const Duration(seconds: 20),
    );
  }
}
