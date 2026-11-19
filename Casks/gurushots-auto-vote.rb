cask "gurushots-auto-vote" do
  version "1.16.5"
  sha256 "212743df39f232a578779ebc91454e29ed5ef241a2168fcb8f5beede9fcecd2c"

  url "https://github.com/isthisgitlab/gurushots-auto-vote/releases/download/v#{version}/GuruShotsAutoVote-v#{version}-arm64.dmg"
  name "GuruShots Auto Vote"
  desc "Desktop app for managing GuruShots challenges"
  homepage "https://github.com/isthisgitlab/gurushots-auto-vote"

  auto_updates true
  depends_on arch: :arm64
  depends_on :macos

  app "GuruShotsAutoVote.app"
end
