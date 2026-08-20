require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoScrollToTop'
  s.version        = package['version']
  s.summary        = 'Pre-empt the iOS status-bar tap before it scrolls'
  s.description    = package['description']
  s.author         = 'Gaven Henry'
  s.homepage       = 'https://github.com/substreamer'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/substreamer/substreamer-rn.git', tag: s.version.to_s }
  s.static_framework = true
  s.license        = { :type => 'MIT' }

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
