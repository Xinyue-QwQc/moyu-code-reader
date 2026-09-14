# Enumerate real installed font families and probe glyphs, not font-name guesses.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName 'PresentationCore, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'
$zh = @(0x4E2D, 0x6587, 0x5C0F, 0x8BF4, 0x9605, 0x8BFB, 0x5929, 0x5730, 0x4EBA, 0x5FC3)
$latin = @(0x41, 0x5A, 0x61, 0x7A, 0x30, 0x39)
$result = @(
  foreach ($family in [System.Windows.Media.Fonts]::SystemFontFamilies) {
    $chinese = $false
    $alphabet = $false
    foreach ($face in $family.GetTypefaces()) {
      $glyph = $null
      if (!$face.TryGetGlyphTypeface([ref]$glyph)) { continue }
      $map = $glyph.CharacterToGlyphMap
      if (@($zh | Where-Object { $map.ContainsKey($_) -and $map[$_] -ne 0 }).Count -eq $zh.Count) { $chinese = $true }
      if (@($latin | Where-Object { $map.ContainsKey($_) -and $map[$_] -ne 0 }).Count -eq $latin.Count) { $alphabet = $true }
      if ($chinese -and $alphabet) { break }
    }
    if (!$chinese -and !$alphabet) { continue }
    $displayName = $family.Source
    foreach ($entry in $family.FamilyNames.GetEnumerator()) {
      if ($entry.Key.IetfLanguageTag -match '^zh') { $displayName = $entry.Value; break }
    }
    [pscustomobject]@{ family = $family.Source; displayName = $displayName; chinese = $chinese; latin = $alphabet }
  }
)
ConvertTo-Json -InputObject $result -Compress
