export default {
  listDirectoryAsync: jest.fn().mockResolvedValue([]),
  listDirectoryWithSizesAsync: jest.fn().mockResolvedValue([]),
  getDirectorySizeAsync: jest.fn().mockResolvedValue(0),
  deleteFileAsync: jest.fn().mockResolvedValue(false),
  deleteDirectoryAsync: jest.fn().mockResolvedValue(false),
  downloadFileAsyncWithProgress: jest.fn().mockResolvedValue({ uri: '', bytes: 0 }),
  addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
};
