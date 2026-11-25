using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Litera
{
    public sealed class Axis
    {
        public string tag, name;
        public double min, max, value;
    }

    public sealed class Instance
    {
        public string name;
        public double[] values;
    }

    public sealed class Face
    {
        public int id, weight;
        public string name;
        public bool italic, cyrillic;
        public int[] coverage;
        public Axis[] axes;
        public Instance[] instances;
    }

    public sealed class Family
    {
        public string name;
        public bool removable;
        public long addedAt;
        public Face[] faces;
    }

    internal sealed class Catalog
    {
        internal const string RegistryPath = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
        private static readonly string[] Extensions = { ".ttf", ".otf", ".ttc", ".otc" };
        internal readonly List<FontSource> Sources = new List<FontSource>();
        internal readonly Dictionary<string, string[]> RemovalPaths = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
        public Family[] families;
        public int skipped;

        internal static Catalog Scan()
        {
            var catalog = new Catalog();
            string windowsFonts = Environment.GetFolderPath(Environment.SpecialFolder.Fonts);
            string userFonts = UserFonts;
            var stock = new HashSet<string>(ReadLines("windows-fonts.txt"), StringComparer.OrdinalIgnoreCase);
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var machinePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            AddDirectory(paths, userFonts);
            AddRegistry(paths, Registry.CurrentUser, userFonts, windowsFonts);
            AddRegistry(machinePaths, Registry.LocalMachine, windowsFonts, null);
            paths.UnionWith(machinePaths);

            var groups = new Dictionary<string, List<FontSource>>(StringComparer.OrdinalIgnoreCase);
            var familyPaths = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
            var sharedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string path in paths.OrderByDescending(p => p.StartsWith(userFonts + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                                         .ThenBy(p => p, StringComparer.OrdinalIgnoreCase))
            {
                if (String.Equals(Path.GetDirectoryName(path), windowsFonts, StringComparison.OrdinalIgnoreCase) &&
                    stock.Contains(Path.GetFileName(path))) continue;
                try
                {
                    FontSource[] files = FontSource.Read(path).ToArray();
                    if (files.Select(font => font.Family).Distinct(StringComparer.OrdinalIgnoreCase).Skip(1).Any())
                        sharedPaths.Add(path);
                    foreach (FontSource font in files)
                    {
                        HashSet<string> locations;
                        if (!familyPaths.TryGetValue(font.Family, out locations))
                        {
                            locations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            familyPaths.Add(font.Family, locations);
                        }
                        locations.Add(path);
                        List<FontSource> faces;
                        if (!groups.TryGetValue(font.Family, out faces))
                        {
                            faces = new List<FontSource>();
                            groups.Add(font.Family, faces);
                        }
                        if (faces.Any(match => Key(match.Face.name) == Key(font.Face.name) &&
                                              match.Face.axes.Select(a => a.tag).SequenceEqual(font.Face.axes.Select(a => a.tag)))) continue;
                        font.Face.id = catalog.Sources.Count;
                        catalog.Sources.Add(font);
                        faces.Add(font);
                    }
                }
                catch (IOException) { catalog.skipped++; }
                catch (InvalidDataException) { catalog.skipped++; }
                catch (UnauthorizedAccessException) { catalog.skipped++; }
                catch (ArgumentException) { catalog.skipped++; }
                catch (OverflowException) { catalog.skipped++; }
            }
            catalog.families = groups.Select(group =>
            {
                var locations = familyPaths[group.Key];
                bool removable = locations.All(path => IsUserFontPath(path) && !sharedPaths.Contains(path) && !machinePaths.Contains(path));
                if (removable) catalog.RemovalPaths.Add(group.Key, locations.ToArray());
                return new Family
                {
                    name = group.Key,
                    removable = removable,
                    addedAt = locations.Select(FileArrivalTime).Max(),
                    faces = group.Value.Select(source => source.Face)
                        .OrderBy(face => face.italic).ThenBy(face => face.weight)
                        .ThenBy(face => face.name, StringComparer.OrdinalIgnoreCase).ToArray()
                };
            }).OrderBy(family => family.name, StringComparer.CurrentCultureIgnoreCase).ToArray();
            return catalog;
        }

        private static long FileArrivalTime(string path)
        {
            try
            {
                long timestamp = new DateTimeOffset(File.GetCreationTimeUtc(path)).ToUnixTimeMilliseconds();
                return Math.Max(0, timestamp);
            }
            catch (IOException) { return 0; }
            catch (UnauthorizedAccessException) { return 0; }
        }

        internal static string UserFonts
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Windows", "Fonts"); }
        }

        internal static bool IsUserFontPath(string path)
        {
            return String.Equals(Path.GetDirectoryName(path), UserFonts, StringComparison.OrdinalIgnoreCase);
        }

        private static string Key(string name)
        {
            return Regex.Replace(name.Normalize(NormalizationForm.FormKC).ToLowerInvariant(), @"[^\p{L}\p{N}]", "");
        }

        private static IEnumerable<string> ReadLines(string resource)
        {
            using (var reader = new StreamReader(Program.Resource(resource)))
            {
                for (string line = reader.ReadLine(); line != null; line = reader.ReadLine())
                    if (line.Length != 0) yield return line;
            }
        }

        private static void AddDirectory(HashSet<string> paths, string directory)
        {
            if (Directory.Exists(directory))
                foreach (string path in Directory.EnumerateFiles(directory)) AddPath(paths, path);
        }

        private static void AddRegistry(HashSet<string> paths, RegistryKey root, string directory, string fallback)
        {
            using (RegistryKey key = root.OpenSubKey(RegistryPath))
            {
                if (key == null) return;
                foreach (string name in key.GetValueNames())
                {
                    string path = key.GetValue(name) as string;
                    if (String.IsNullOrWhiteSpace(path)) continue;
                    path = Environment.ExpandEnvironmentVariables(path);
                    if (Path.IsPathRooted(path)) AddPath(paths, path);
                    else
                    {
                        AddPath(paths, Path.Combine(directory, path));
                        if (fallback != null) AddPath(paths, Path.Combine(fallback, path));
                    }
                }
            }
        }

        private static void AddPath(HashSet<string> paths, string path)
        {
            if (Extensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase) && File.Exists(path))
                paths.Add(Path.GetFullPath(path));
        }
    }

    internal sealed class FontSource
    {
        internal string Family;
        internal Face Face;
        private string path;
        private int faceOffset;

        internal static IEnumerable<FontSource> Read(string path)
        {
            byte[] data = File.ReadAllBytes(path);
            var file = new FontData(data);
            if (file.Tag(0) != "ttcf")
            {
                yield return ReadFace(file, path, 0);
                yield break;
            }
            int count = file.Int(8);
            if (count > (data.Length - 12) / 4) throw new InvalidDataException();
            for (int index = 0; index < count; index++)
                yield return ReadFace(file, path, file.Int(12 + 4 * index));
        }

        private static FontSource ReadFace(FontData file, string path, int offset)
        {
            var tables = file.Tables(offset);
            var names = file.Names(tables["name"]);
            string family = Find(names, 16) ?? Find(names, 1) ?? Path.GetFileNameWithoutExtension(path);
            string style = Find(names, 17) ?? Find(names, 2) ?? "Regular";
            // Office's Narrow files share the typographic family name of the Windows Arial files.
            if (family == "Arial" && Find(names, 1) == "Arial Narrow")
            {
                family = "Arial Narrow";
                style = Find(names, 2) ?? style;
            }
            int os2, head, cmap, fvar;
            var face = new Face
            {
                name = style,
                weight = tables.TryGetValue("OS/2", out os2) ? file.Short(os2 + 4) : 400,
                italic = tables.TryGetValue("head", out head) && (file.Short(head + 44) & 2) != 0,
                axes = new Axis[0],
                instances = new Instance[0],
                coverage = tables.TryGetValue("cmap", out cmap) ? file.Coverage(cmap) : new int[0]
            };
            if (tables.TryGetValue("fvar", out fvar)) file.Variations(fvar, names, face);
            face.cyrillic = "ЁёйцукенгшщзхъфывапролджэячсмитьбюЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ".All(c => Contains(face.coverage, c));
            return new FontSource { Family = family, Face = face, path = path, faceOffset = offset };
        }

        private static bool Contains(int[] ranges, int code)
        {
            for (int i = 0; i < ranges.Length && ranges[i] <= code; i += 2)
                if (code <= ranges[i + 1]) return true;
            return false;
        }

        internal Stream Open()
        {
            if (faceOffset == 0) return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return new MemoryStream(new FontData(File.ReadAllBytes(path)).Extract(faceOffset), false);
        }

        internal static string Find(Dictionary<int, string> names, int id)
        {
            string name;
            return names.TryGetValue(id, out name) ? name : null;
        }
    }

    internal sealed class FontData
    {
        private readonly byte[] bytes;
        internal FontData(byte[] data) { bytes = data; }

        internal int Short(int pos)
        {
            if (pos < 0 || pos > bytes.Length - 2) throw new InvalidDataException();
            return bytes[pos] << 8 | bytes[pos + 1];
        }

        private uint Word(int pos) { return (uint)Short(pos) << 16 | (uint)Short(pos + 2); }
        internal int Int(int pos) { return checked((int)Word(pos)); }
        private double Fixed(int pos) { return unchecked((int)Word(pos)) / 65536.0; }
        internal string Tag(int pos)
        {
            if (pos < 0 || pos > bytes.Length - 4) throw new InvalidDataException();
            return Encoding.ASCII.GetString(bytes, pos, 4);
        }

        internal Dictionary<string, int> Tables(int offset)
        {
            var tables = new Dictionary<string, int>(StringComparer.Ordinal);
            int count = Short(offset + 4);
            for (int i = 0; i < count; i++)
            {
                int row = offset + 12 + 16 * i;
                int start = Int(row + 8), length = Int(row + 12);
                if (start > bytes.Length - length) throw new InvalidDataException();
                tables[Tag(row)] = start;
            }
            if (!tables.ContainsKey("name")) throw new InvalidDataException();
            return tables;
        }

        internal Dictionary<int, string> Names(int table)
        {
            var names = new Dictionary<int, string>();
            var scores = new Dictionary<int, int>();
            int count = Short(table + 2), storage = table + Short(table + 4);
            for (int i = 0; i < count; i++)
            {
                int row = table + 6 + 12 * i;
                int platform = Short(row), language = Short(row + 4), id = Short(row + 6);
                bool unicode = platform == 0 || platform == 3;
                if (!unicode && (platform != 1 || Short(row + 2) != 0)) continue;
                int score = (unicode ? 2 : 1) + ((platform == 3 && (language & 1023) == 9) || (platform == 1 && language == 0) ? 4 : 0);
                int oldScore;
                if (scores.TryGetValue(id, out oldScore) && oldScore >= score) continue;
                int length = Short(row + 8), offset = storage + Short(row + 10);
                var encoding = unicode ? Encoding.BigEndianUnicode : Encoding.GetEncoding(10000);
                if (offset > bytes.Length - length) continue;
                string name = encoding.GetString(bytes, offset, length).Trim('\0', ' ', '\t', '\r', '\n');
                if (String.IsNullOrWhiteSpace(name)) continue;
                names[id] = name;
                scores[id] = score;
            }
            return names;
        }

        internal void Variations(int table, Dictionary<int, string> names, Face face)
        {
            int axesStart = table + Short(table + 4), axisCount = Short(table + 8), axisSize = Short(table + 10);
            int instanceCount = Short(table + 12), instanceSize = Short(table + 14);
            if (axisSize < 20 || axisCount > 128 || instanceSize < 4 + 4 * axisCount) return;
            var axes = new List<Axis>();
            var shown = new List<int>();
            for (int i = 0; i < axisCount; i++)
            {
                int row = axesStart + i * axisSize;
                string tag = Tag(row);
                if ((Short(row + 16) & 1) != 0 || !Regex.IsMatch(tag, "^[A-Za-z0-9 ]{4}$")) continue;
                var axis = new Axis { tag = tag, name = FontSource.Find(names, Short(row + 18)) ?? tag,
                    min = Fixed(row + 4), value = Fixed(row + 8), max = Fixed(row + 12) };
                if (axis.min <= axis.value && axis.value <= axis.max && axis.min < axis.max)
                {
                    axes.Add(axis);
                    shown.Add(i);
                }
            }
            var instances = new List<Instance>();
            for (int i = 0; i < instanceCount; i++)
            {
                int row = axesStart + (axisCount * axisSize) + (i * instanceSize);
                string name = FontSource.Find(names, Short(row));
                if (name != null) instances.Add(new Instance { name = name, values = shown.Select(n => Fixed(row + 4 + n * 4)).ToArray() });
            }
            face.axes = axes.ToArray();
            face.instances = instances.ToArray();
        }

        internal int[] Coverage(int table)
        {
            var ranges = new List<int[]>();
            var seen = new HashSet<int>();
            int count = Short(table + 2);
            for (int i = 0; i < count; i++)
            {
                int row = table + 4 + i * 8, platform = Short(row), encoding = Short(row + 2);
                if (platform != 0 && !(platform == 3 && (encoding == 1 || encoding == 10))) continue;
                int map = table + Int(row + 4);
                if (!seen.Add(map)) continue;
                int format = Short(map);
                if (format == 4) ReadBmp(map, ranges);
                if (format == 12 || format == 13)
                {
                    int groups = Int(map + 12);
                    if (groups > (bytes.Length - map - 16) / 12) continue;
                    for (int j = 0; j < groups; j++)
                    {
                        int group = map + 16 + j * 12;
                        int start = Int(group), end = Int(group + 4);
                        if (Word(group + 8) == 0)
                        {
                            if (format == 13) continue;
                            start++;
                        }
                        if (start <= end && end <= 0x10ffff) ranges.Add(new[] { start, end });
                    }
                }
            }
            var merged = new List<int>();
            foreach (var pair in ranges.OrderBy(pair => pair[0]).ThenBy(pair => pair[1]))
            {
                int last = merged.Count - 1;
                if (last >= 0 && pair[0] <= merged[last] + 1) merged[last] = Math.Max(merged[last], pair[1]);
                else merged.AddRange(pair);
            }
            return merged.ToArray();
        }

        private void ReadBmp(int map, List<int[]> ranges)
        {
            int endTable = map + 14, segments = Short(map + 6) / 2;
            int startTable = endTable + 2 * segments + 2, deltaTable = startTable + 2 * segments, offsetTable = deltaTable + 2 * segments;
            int limit = map + Short(map + 2);
            for (int i = 0; i < segments; i++)
            {
                int end = Math.Min(0xFFFE, Short(endTable + 2 * i)), begin = Short(startTable + 2 * i);
                int delta = Short(deltaTable + 2 * i), offsetPos = offsetTable + 2 * i, offset = Short(offsetPos);
                int run = -1;
                for (int code = begin; code <= end; code++)
                {
                    int glyph = code;
                    if (offset != 0)
                    {
                        int pos = offsetPos + offset + 2 * (code - begin);
                        glyph = pos <= limit - 2 ? Short(pos) : 0;
                    }
                    bool present = (offset == 0 || glyph != 0) && ((glyph + delta) & 0xFFFF) != 0;
                    if (present && run < 0) run = code;
                    if (!present && run >= 0) { ranges.Add(new[] { run, code - 1 }); run = -1; }
                }
                if (run >= 0) ranges.Add(new[] { run, end });
            }
        }

        internal byte[] Extract(int offset)
        {
            int count = Short(offset + 4), header = 12 + 16 * count;
            int length = header;
            for (int i = 0; i < count; i++) length = checked(length + Align(Int(offset + 24 + 16 * i)));
            var result = new byte[length];
            Buffer.BlockCopy(bytes, offset, result, 0, header);
            int target = header, head = -1;
            for (int i = 0; i < count; i++)
            {
                int row = 12 + 16 * i, size = Int(offset + row + 12);
                Buffer.BlockCopy(bytes, Int(offset + row + 8), result, target, size);
                WriteWord(result, row + 8, (uint)target);
                if (Tag(offset + row) == "head") head = target;
                target += Align(size);
            }
            if (head >= 0)
            {
                WriteWord(result, head + 8, 0);
                var font = new FontData(result);
                uint checksum = 0;
                for (int i = 0; i < result.Length; i += 4) checksum = unchecked(checksum + font.Word(i));
                WriteWord(result, head + 8, unchecked(0xB1B0AFBAU - checksum));
            }
            return result;
        }

        private static int Align(int bytes) { return checked(bytes + 3) & ~3; }

        private static void WriteWord(byte[] data, int pos, uint value)
        {
            data[pos] = (byte)(value >> 24);
            data[pos + 1] = (byte)(value >> 16);
            data[pos + 2] = (byte)(value >> 8);
            data[pos + 3] = (byte)value;
        }
    }
}
